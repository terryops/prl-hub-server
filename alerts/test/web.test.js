import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  makeEnv,
  call as rawCall,
  installFetch,
  setNow,
  restoreNow,
  T0,
  register,
  tok,
  tick,
} from "./helpers.js";
import { parseStats, reserveBudget } from "../src/poolstats.js";
import { parseMiner, SOURCES } from "../src/pools.js";
import { checkPayments, createOrder, orderSats } from "../src/orders.js";
import { chainHeight } from "../src/chain.js";
import worker from "../src/index.js";
import { sha256 } from "../src/http.js";
import { logError } from "../src/log.js";
import {
  b64,
  unb64,
  encrypt,
  importPair,
  vapid,
  validateSubscription,
  send as sendWebPush,
} from "../src/webpush.js";
import { seedSession } from "./account-fixture.js";
const call = async (env, method, path, body, h) => {
  const token = h?.Authorization?.replace("Bearer ", "");
  if (["A".repeat(43), "B".repeat(43)].includes(token)) await seedSession(env, token);
  return rawCall(env, method, path, body, h);
};
const realFetch = globalThis.fetch;
afterEach(() => {
  restoreNow();
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});
const fixture = (n) =>
  readFileSync(new URL(`../../Tests/Fixtures/${n}`, import.meta.url), "utf8");
const f = (n) => JSON.parse(fixture(n));
const near = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1e-7, expected * 1e-12),
    `${actual} != ${expected}`,
  );
const value = (s, w) =>
  s.workers.reduce((n, x) => n + (x.rates[w] || 0), 0) || s.rates[w] || 0;
const addr = "prl1" + "a".repeat(38),
  auth = "A".repeat(43),
  headers = { Authorization: `Bearer ${auth}` },
  gid = await sha256(auth);
const seed = (env, pro = false) =>
  env.DB.raw
    .prepare(
      "INSERT INTO groups (gid, created_at, seen_at, pro_at, pro_src) VALUES (?, ?, ?, ?, 'admin')",
    )
    .run(gid, T0, T0, pro ? T0 : null);
const notificationHeaders = async (env, i) => {
  if (i === 0) return headers;
  const token = "C".repeat(40) + String(i).padStart(3, "0");
  await seedSession(env, token, gid, `fixture-notification-${String(i).padStart(4, "0")}`);
  return { Authorization: `Bearer ${token}` };
};
const quote = (env, time = T0) => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith("/api/") ? Response.json({ blockbook: { bestHeight: 1000, inSync: true } }) : previous(url, init);
  return env.DB.raw
    .prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('price', ?, ?)")
    .run(JSON.stringify({ usd: 0.8, ts: time }), time);
};
const transaction = (
  sats,
  confirmations = 0,
  id = "a".repeat(64),
  time = T0 + 1,
) => ({
  txid: id,
  blockTime: time,
  blockHeight: confirmations ? 1001 : undefined,
  confirmations,
  vin: [{ addresses: ["sender"], value: String(sats + 100) }],
  vout: [{ addresses: [addr], value: String(sats) }],
});
const blockbook = (txs) => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({
      balance: "0",
      unconfirmedBalance: "0",
      txs: txs.length,
      transactions: txs,
      totalPages: 1,
    });
  };
  return requests;
};

test("address: outgoing mempool balance stays signed and exact", async () => {
  const env = makeEnv();
  globalThis.fetch = async () => Response.json({
    balance: "9007199254740993", unconfirmedBalance: "-9007199254740992", txs: 0,
  });
  const result = await call(env, "POST", "/v1/address", { addr });
  assert.equal(result.status, 200);
  assert.equal(result.body.balance, "9007199254740993");
  assert.equal(result.body.unconfirmed, "-9007199254740992");
  for (const invalid of ["", "1.2", "--1", 1]) {
    globalThis.fetch = async () => Response.json({ balance: "1", unconfirmedBalance: invalid, txs: 0 });
    assert.equal((await call(env, "POST", "/v1/address", { addr })).status, 502);
  }
});

for (const [pool, files, pending, paid, window, count, online, total] of [
  [
    "AlphaPool",
    ["alphapool_miner_idle.json"],
    0.92900789,
    13.19344688,
    "live",
    1,
    0,
    0,
  ],
  [
    "Lucky Pool",
    ["luckypool_miner.json"],
    13.29889069,
    3039.00403603,
    "live",
    3,
    3,
    1896897765508319,
  ],
  [
    "HeroMiners",
    ["herominers_miner.json"],
    13.54228383,
    510.91818277,
    "day",
    3,
    3,
    1415614134065561.8,
  ],
  [
    "Pearl Fortune",
    [
      "pearlfortune_miner.json",
      "pearlfortune_connections.json",
      "pearlfortune_ledger.json",
    ],
    1.10506955,
    63.40524874,
    "day",
    2,
    2,
    1146779915064822.2,
  ],
  [
    "PearlHash",
    ["pearlhash_account.json", "pearlhash_stats.json"],
    1.921944989121971,
    54.67318902928431,
    "live",
    9,
    9,
    486951712142131.2,
  ],
  [
    "Kryptex",
    ["kryptex_workers.json", "kryptex_balance.json", "kryptex_payouts.json"],
    39.809957971072265,
    2903.8023297,
    "m30",
    1,
    1,
    6805439436915416,
  ],
  [
    "F2Pool",
    ["f2pool_workers.json", "f2pool_payouts.json", "f2pool_page.html"],
    0.43125,
    1003.90106604,
    "m15",
    3,
    1,
    (12.51 + 3.2) * 1e12,
  ],
])
  test(`full stats: ${pool} matches Swift fixtures`, () => {
    const s = parseStats(
      pool,
      files.map((x) => (x.endsWith("html") ? fixture(x) : f(x))),
      1790475200,
    );
    near(s.pending, pending);
    near(s.paid, paid);
    near(value(s, window), total);
    assert.equal(s.workers.length, count);
    assert.equal(s.workers.filter((x) => x.online).length, online);
    if (pool === "Pearl Fortune" || pool === "PearlHash")
      assert.equal(s.workers[0].rates.day, undefined);
    if (pool === "F2Pool") {
      near(s.rates.m15, 12509998964918.04);
      assert.deepEqual(s.windows, ["m15", "day"]);
      near(s.workers.find((x) => x.name === "rig-b").rates.day, 1234.5e12);
    }
  });
test("full stats: Jetski matches Swift fixtures — 5m live, 1h, 6h; grains to PRL", () => {
  const s = parseStats("Jetski", [f("jetski_miner.json")], 1792283530);
  assert.deepEqual(s.windows, ["live", "hour", "h6"]);
  near(s.pending, 4.19832521);
  near(s.paid, 348.29822081);
  near(value(s, "live"), 658561652053333.4);
  near(value(s, "hour"), 634700722631111.1);
  near(value(s, "h6"), 659754698524444.5);
  assert.deepEqual(s.workers.map((x) => [x.name, x.online]), [["AP201", true], ["C4000F", true], ["NZXTH3", true], ["P3630", false]]);
  near(s.workers[3].rates.h6, 75957291994074.08);
  assert.equal(s.workers[0].rates.day, undefined);
  assert.equal(parseStats("Jetski", [f("jetski_miner_empty.json")]).missing, true);
});

test("full stats: definitive strangers and unconfirmed F2 estimate", () => {
  for (const [pool, file] of [
    ["AlphaPool", "alphapool_miner_empty.json"],
    ["HeroMiners", "herominers_miner_empty.json"],
    ["Kryptex", "kryptex_workers_empty.json"],
  ])
    assert.equal(parseStats(pool, [f(file)]).missing, true);
  assert.equal(
    parseStats("Pearl Fortune", [
      f("pearlfortune_miner_empty.json"),
      f("pearlfortune_connections_empty.json"),
      f("pearlfortune_ledger_empty.json"),
    ]).missing,
    true,
  );
  const s = parseStats("F2Pool", [
    f("f2pool_workers.json"),
    f("f2pool_payouts.json"),
    'data-balance="0" revenue-est-today-tooltip class="num">2.5',
  ]);
  assert.equal(s.pending, 2.5);
  assert.equal(s.pendingKind, "todayEstimate");
});
test("web data: validation, 502, 404 missing and per-IP shared read limit", async () => {
  const env = makeEnv();
  setNow(T0);
  assert.equal(
    (
      await call(env, "POST", "/v1/pool/stats", {
        pool: "F2Pool",
        addr: "https://attacker",
      })
    ).status,
    400,
  );
  globalThis.fetch = async () => new Response("down", { status: 500 });
  assert.deepEqual(
    await call(env, "POST", "/v1/pool/stats", { pool: "PearlHash", addr }),
    { status: 502, body: { ok: false, error: "upstream" } },
  );
  globalThis.fetch = async () => new Response("", { status: 404 });
  assert.equal(
    (await call(env, "POST", "/v1/pool/stats", { pool: "PearlHash", addr }))
      .body.missing,
    true,
  );
  env.RL_READ = { limit: async () => ({ success: false }) };
  for (const [method, path, body] of [
    ["GET", "/v1/price/history", undefined],
    ["POST", "/v1/address", { addr }],
    ["POST", "/v1/pool/stats", { pool: "PearlHash", addr }],
  ])
    assert.equal((await call(env, method, path, body)).status, 429);
});
test("web budget: actual subrequests and atomic exhaustion", async () => {
  const env = makeEnv();
  setNow(T0);
  const reservations = await Promise.all(
    Array.from({ length: 11 }, () => reserveBudget(env.DB, "PearlHash", 2, T0)),
  );
  assert.equal(reservations.filter(Boolean).length, 10);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({});
  };
  const r = await call(env, "POST", "/v1/pool/stats", {
    pool: "PearlHash",
    addr,
  });
  assert.equal(r.status, 429);
  assert.equal(requests, 0);
  assert.equal(r.body.retry_after, 60);
});
test("web cache: hashed POST keys, edge TTL and client no-store", async () => {
  const env = makeEnv();
  setNow(T0);
  let key,
    stored,
    requests = 0;
  globalThis.caches = {
    default: {
      match: async (req) => {
        key = req.url;
        return stored?.clone();
      },
      put: async (_req, res) => {
        stored = res;
      },
    },
  };
  globalThis.fetch = async () => {
    requests++;
    return Response.json(f("alphapool_miner_idle.json"));
  };
  const r = await call(env, "POST", "/v1/pool/stats", {
    pool: "AlphaPool",
    addr,
  });
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(!key.includes(addr));
  assert.equal(stored.headers.get("cache-control"), "public, max-age=300");
  await call(env, "POST", "/v1/pool/stats", { pool: "AlphaPool", addr });
  assert.equal(requests, 1);
});
test("native price route keeps its response when a background cache write fails", async () => {
  const env = makeEnv(); setNow(T0); quote(env);
  const tasks = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => { throw Error("cache unavailable"); } } };
  const response = await worker.fetch(new Request("https://prl.test/v1/price"), env, { waitUntil: (task) => tasks.push(task.catch(() => {})) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { usd: 0.8, ts: T0, stale: false }); await Promise.all(tasks);
});
test("price history: 5-minute buckets never mix sources", async () => {
  const env = makeEnv();
  setNow(T0);
  for (const [offset, usd, src] of [
    [-400, 0.7, "median"],
    [-390, 0.9, "safetrade"],
    [-360, 0.8, "median"],
    [0, 0.85, "median"],
  ])
    env.DB.raw
      .prepare("INSERT INTO prices VALUES (?,?,?)")
      .run(T0 + offset, usd, src);
  const r = await call(env, "GET", "/v1/price/history");
  assert.equal(r.body.source, "median");
  assert.ok(r.body.points.every((x) => x[1] !== 0.9));
  assert.equal(r.body.points.at(-1)[1], 0.85);
});
test("address: bigint deltas count all own inputs and outputs", async () => {
  const env = makeEnv();
  const tx = transaction(200000000, 4);
  tx.vout.push({ addresses: [addr], value: "9007199254740993" });
  tx.vin = [{ addresses: [addr], value: "100000000" }];
  blockbook([tx]);
  const r = await call(env, "POST", "/v1/address", { addr });
  assert.equal(r.body.history[0].delta, "9007199354740993");
  assert.equal(
    (await call(env, "POST", "/v1/address", { addr: "https://other" })).status,
    400,
  );
});
test("orders: integer amount example and decimal rounding", () => {
  assert.equal(orderSats(4.99, 0.8, 3817), 624381700);
  assert.equal(orderSats(5, 0.8, 3817), 625381700);
  assert.equal(orderSats(5, 3, 1), 167000100);
  assert.throws(() => orderSats(5, 0, 1));
});
test("orders: no address, stale price, auth and hidden admin", async () => {
  const env = makeEnv();
  setNow(T0);
  assert.equal(
    (await call(env, "POST", "/v1/orders", undefined, headers)).status,
    503,
  );
  assert.equal((await call(env, "POST", "/v1/orders")).status, 401);
  assert.equal((await call(env, "GET", "/v1/admin/payments")).status, 404);
  const r = await call(env, "GET", "/v1/me", undefined, headers);
  assert.equal(r.body.pro, false);
  assert.equal(r.body.pay.enabled, false);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM groups").n, 0);
  env.PAY_ADDRESS = addr;
  quote(env, T0 - 301);
  assert.equal(
    (await call(env, "POST", "/v1/orders", undefined, headers)).body.error,
    "price_unavailable",
  );
});
test("orders: unique tail retry, repeat and concurrent checkout are idempotent", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0);
  quote(env);
  await createOrder(env, "b".repeat(64), "ip", () => 3817);
  let tail = 3816;
  const res = await createOrder(env, gid, "ip", () => ++tail);
  const order = await res.json();
  assert.equal(order.amount, "6.253818");
  const repeated = await call(env, "POST", "/v1/orders", undefined, headers);
  assert.equal(repeated.body.id, order.id);
  const gid2 = "c".repeat(64);
  await Promise.all([
    createOrder(env, gid2, "ip"),
    createOrder(env, gid2, "ip"),
  ]);
  assert.equal(
    env.DB.one("SELECT COUNT(*) n FROM orders WHERE gid = ?", gid2).n,
    1,
  );
});
test("payment: seen then paid and repeated checks are idempotent", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0);
  quote(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  const tx = transaction(order.sats);
  const apns = installFetch();
  const fetchMock = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes("blockbook")
      ? Response.json({ transactions: [tx], totalPages: 1 })
      : fetchMock(url, init);
  setNow(T0 + 2);
  await checkPayments(env);
  assert.equal(env.DB.one("SELECT status FROM orders").status, "seen");
  assert.equal(env.DB.one("SELECT pro_at FROM groups").pro_at, null);
  tx.confirmations = 1;
  setNow(T0 + 20);
  await checkPayments(env);
  assert.equal(env.DB.one("SELECT status FROM orders").status, "paid");
  assert.equal(env.DB.one("SELECT pro_src FROM groups").pro_src, "prl");
  setNow(T0 + 40);
  await checkPayments(env);
  assert.equal(
    (
      await call(env, "GET", `/v1/orders/${order.id}`, undefined, {
        Authorization: `Bearer ${"B".repeat(43)}`,
      })
    ).status,
    404,
  );
});
test("payment: no pending orders avoids fetch; global 15-second polling lock", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0);
  const calls = blockbook([]);
  await checkPayments(env);
  assert.equal(calls.length, 0);
  quote(env);
  await createOrder(env, gid, "ip");
  await Promise.all([checkPayments(env), checkPayments(env)]);
  assert.equal(calls.length, 1);
  await checkPayments(env);
  assert.equal(calls.length, 1);
});
test("payment: amount off by one and self-change never grant Pro; late exact payment does", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0);
  quote(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  const tx = transaction(order.sats + 1, 1),
    self = transaction(order.sats, 1, "b".repeat(64));
  self.vin[0].addresses = [addr];
  blockbook([tx, self]);
  setNow(T0 + 1900);
  await checkPayments(env);
  assert.equal(env.DB.one("SELECT pro_at FROM groups").pro_at, null);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM payments").n, 1);
  blockbook([transaction(order.sats, 1, "c".repeat(64), T0 + 1901)]);
  setNow(T0 + 1920);
  await checkPayments(env);
  assert.equal(env.DB.one("SELECT status FROM orders").status, "paid");
});
test("payment: historical transfer cannot redeem a later recycled amount", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0);
  quote(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  blockbook([{ ...transaction(order.sats, 100, "a".repeat(64), T0 - 100), blockHeight: 900 }]);
  await checkPayments(env);
  assert.equal(env.DB.one("SELECT pro_at FROM groups").pro_at, null);
});
test("admin: token enforced and manual grant", async () => {
  const env = makeEnv({ ADMIN_TOKEN: "admin" });
  setNow(T0);
  assert.equal(
    (await call(env, "POST", "/v1/admin/grant", { gid })).status,
    404,
  );
  const r = await call(
    env,
    "POST",
    "/v1/admin/grant",
    { gid, note: "support" },
    { Authorization: "Bearer admin" },
  );
  assert.equal(r.status, 200);
  assert.equal(env.DB.one("SELECT pro_src FROM groups").pro_src, "admin");
});
test("config storage: hourly pruning removes stale free groups while preserving paid and seen payments", async () => {
  const env = makeEnv(); setNow(T0); globalThis.fetch = async () => new Response(null, { status: 500 });
  const stale = T0 - 31 * 86400;
  for (const [id, pro] of [["old", null], ["paid", stale], ["seen", null]])
    env.DB.raw.prepare("INSERT INTO groups (gid,created_at,seen_at,pro_at,config) VALUES (?,?,?,?,?)").run(id, stale, stale, pro, "ciphertext");
  env.DB.raw.prepare("INSERT INTO orders (id,gid,usd,rate,sats,created_at,expires_at,status) VALUES ('seen','seen',5,1,123,?,?,'seen')").run(stale, stale + 1800);
  await tick(env);
  assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid='old'"), null);
  assert.ok(env.DB.one("SELECT gid FROM groups WHERE gid='paid'"));
  assert.ok(env.DB.one("SELECT gid FROM groups WHERE gid='seen'"));
  assert.ok(env.DB.one("SELECT id FROM orders WHERE status='seen'"));
});
test("payments: settled page entries skip all per-transaction queries and writes", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr }); setNow(T0); quote(env);
  await createOrder(env, gid, "ip", () => 3817);
  const txs = Array.from({ length: 50 }, (_, i) => transaction(100 + i, 100, i.toString(16).padStart(64, "0"), T0 - 86400));
  for (const [i, tx] of txs.entries()) env.DB.raw.prepare("INSERT INTO payments (txid,sats,first_seen,confirmed,order_id,told_owner) VALUES (?,?,?,1,?,?)").run(tx.txid, 100 + i, T0 - 86400, i % 2 ? null : "settled", i % 2);
  blockbook(txs); env.DB.log.length = 0; await checkPayments(env);
  assert.ok(env.DB.log.length <= 4, env.DB.log.join("\n"));
  assert.equal(env.DB.log.filter((sql) => /^(INSERT.*payments|UPDATE)/.test(sql)).length, 0);
});
test("payments: a busy page stays under the D1 free invocation query budget and drains on later runs", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr }); setNow(T0); quote(env);
  await createOrder(env, gid, "ip", () => 3817);
  blockbook(Array.from({ length: 50 }, (_, i) => transaction(100 + i, 1, i.toString(16).padStart(64, "0"))));
  for (let i = 0; i < 15; i++) {
    setNow(T0 + 20 * (i + 1)); env.DB.log.length = 0; await checkPayments(env);
    assert.ok(env.DB.log.length <= 45, `${env.DB.log.length} queries`);
  }
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM payments WHERE confirmed=1 AND told_owner=1").n, 50);
});
test("payments: miner timestamp slightly preceding checkout cannot strand a newly confirmed payment", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr }); setNow(T0); quote(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  blockbook([transaction(order.sats, 1, "d".repeat(64), T0 - 120)]);
  setNow(T0 + 60); await checkPayments(env);
  assert.equal(env.DB.one("SELECT status FROM orders").status, "paid");
  assert.equal(env.DB.one("SELECT pro_src FROM groups").pro_src, "prl");
});
test("checkout anchor: documented status endpoint, base normalization and invalid/stale indexer rejection", async () => {
  let info = { bestHeight: 1000, inSync: true };
  globalThis.fetch = async (url) => { assert.equal(String(url), "https://fixture.invalid/api/"); return Response.json({ blockbook: info }); };
  const env = makeEnv({ BLOCKBOOK_BASE: "https://fixture.invalid/api/v2/" });
  assert.equal(await chainHeight(env), 1000);
  for (const invalid of [{ bestHeight: -1, inSync: true }, { bestHeight: "1000", inSync: true }, { bestHeight: 1000, inSync: false }]) { info = invalid; await assert.rejects(chainHeight(env)); }
});
test("orders: seen payment survives quote expiry, me reload and concurrent new checkout", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr }); setNow(T0); quote(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  blockbook([transaction(order.sats, 0)]); setNow(T0 + 1680); await checkPayments(env);
  setNow(T0 + 1900);
  assert.equal((await call(env, "GET", "/v1/me", undefined, headers)).body.order?.id, order.id);
  const responses = await Promise.all([createOrder(env, gid, "ip"), createOrder(env, gid, "ip")]);
  for (const res of responses) assert.equal((await res.json()).id, order.id);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM orders").n, 1);
});
test("pool worker identities and online rules match push parsing for malformed and unnamed workers", () => {
  const cases = [
    ["F2Pool", [{ originData: { workers: [{ name: "bad", status: "" }, { name: "ok", status: " 0 " }] } }]],
    ["PearlHash", [{ connected_workers: [{ worker_name: "", ip: "one", gpu_info: [{ hashrate: 1 }] }, { worker_name: 42, ip: "two", gpu_info: [{ hashrate: 2 }] }, { worker_name: "", ip: "three" }] }]],
    ["AlphaPool", [{ last_seen: T0, workers: [{ name: "rig", online: "no", time: T0 - 700 }] }]],
  ];
  for (const [pool, replies] of cases) {
    const stats = parseStats(pool, replies, T0), push = parseMiner(pool, 200, JSON.stringify(replies[0]), T0);
    const states = (xs) => xs.map(({ name, online, last }) => ({ name, online, last })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(states(stats.workers), states(push.workers));
  }
});
test("pool budget: one IP cannot spend the entire shared pool budget using fresh addresses", async () => {
  const env = makeEnv(); setNow(T0); let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ connected_workers: [] }); };
  for (let i = 0; i < 15; i++) await call(env, "POST", "/v1/pool/stats", { pool: "PearlHash", addr: `prl1${String(i).padStart(38, "a")}` });
  assert.ok(requests <= 6, `one IP used ${requests} upstream requests`);
  const other = await call(env, "POST", "/v1/pool/stats", { pool: "PearlHash", addr }, { "cf-connecting-ip": "192.0.2.2" });
  assert.equal(other.status, 200);
});
test("pool cache: twenty monitors refreshed by tabs each minute reuse the ten-minute PearlHash copy", async () => {
  const env = makeEnv(), entries = new Map(); let requests = 0;
  globalThis.caches = { default: {
    match: async (req) => { const entry = entries.get(req.url); return entry && entry.until > Date.now() ? entry.response.clone() : undefined; },
    put: async (req, response) => { const ttl = Number(response.headers.get("cache-control").match(/max-age=(\d+)/)[1]); entries.set(req.url, { response, until: Date.now() + ttl * 1000 }); },
  } };
  globalThis.fetch = async () => { requests++; return Response.json({ connected_workers: [] }); };
  const targets = Array.from({ length: 20 }, (_, i) => ({ pool: "PearlHash", addr: `prl1${String(i).padStart(38, "a")}` }));
  // Cold accounts are admitted within each IP's share, then reused by every tab.
  for (const [i, target] of targets.entries()) { setNow(T0 + Math.floor(i / 3) * 60); assert.equal((await call(env, "POST", "/v1/pool/stats", target)).status, 200); }
  assert.equal(requests, 40);
  for (const offset of [420, 480, 540]) {
    setNow(T0 + offset);
    const results = await Promise.all(targets.flatMap((target) => [call(env, "POST", "/v1/pool/stats", target), call(env, "POST", "/v1/pool/stats", target)]));
    assert.ok(results.every((r) => r.status === 200));
  }
  assert.equal(requests, 40);
});
test("pool cache: concurrent cold tabs coalesce into one upstream request", async () => {
  const env = makeEnv(); setNow(T0); let requests = 0;
  globalThis.fetch = async () => { requests++; await new Promise((resolve) => setImmediate(resolve)); return Response.json(f("alphapool_miner_idle.json")); };
  const results = await Promise.all(Array.from({ length: 10 }, () => call(env, "POST", "/v1/pool/stats", { pool: "AlphaPool", addr })));
  assert.ok(results.every((r) => r.status === 200)); assert.equal(requests, 1);
});
test("pool cards request the worker URL and headers owned by SOURCES", async () => {
  const env = makeEnv(); setNow(T0); const source = SOURCES.F2Pool, old = source.url, urls = [];
  source.url = () => "https://fixture.invalid/mining?user_name=user&action=get_pagination_workers";
  globalThis.fetch = async (url, init) => { urls.push(String(url)); assert.equal(init.headers["x-requested-with"], String(url).includes("&action=") ? source.headers["x-requested-with"] : undefined); return Response.json({ originData: { workers: [] } }); };
  try { assert.equal((await call(env, "POST", "/v1/pool/stats", { pool: "F2Pool", addr: "a".repeat(32) })).status, 200); assert.equal(urls[0], source.url()); }
  finally { source.url = old; }
});
test("checkout: free quota does not block unpaid orders and an unavailable chain tip never creates a quote", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr, GROUP_LIMIT: "1" }); setNow(T0); quote(env);
  assert.equal((await createOrder(env, gid, "ip")).status, 200);
  assert.equal((await createOrder(env, "b".repeat(64), "ip")).status, 200);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM orders").n, 2);
  const other = makeEnv({ PAY_ADDRESS: addr }); quote(other);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const error = console.error; console.error = () => {};
  try { assert.equal((await createOrder(other, gid, "ip")).status, 503); assert.equal(other.DB.one("SELECT COUNT(*) n FROM orders").n, 0); }
  finally { console.error = error; }
});
test("payment errors retain diagnostics in both order polling and the scheduler", async () => {
  let fail = false;
  const env = makeEnv({ PAY_ADDRESS: addr }, { before: (sql) => { if (fail && sql.includes("MIN(created_at)")) throw Error("reconciler query exploded"); } });
  setNow(T0); quote(env); const order = await (await createOrder(env, gid, "ip")).json();
  installFetch(); fail = true;
  const error = console.error, logs = []; console.error = (...args) => logs.push(args.join(" "));
  try {
    assert.equal((await call(env, "GET", `/v1/orders/${order.id}`, undefined, headers)).status, 200);
    await tick(env);
    const checks = logs.filter((s) => s.includes("payment check failed")); assert.equal(checks.length, 2);
    assert.ok(checks.every((s) => s.includes("reconciler query exploded") && s.includes("web.test.js")));
  } finally { console.error = error; }
});
test("webpush: crypto/config/payload failures are terminal, denied subscriptions dropped, transport retried", async () => {
  const { env } = await pushEnv(), s = await subscription(), sub = { endpoint: s.endpoint, ...s.keys };
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response(null, { status: 201 }); };
  for (const [e, subscription, payload] of [
    [{ ...env, VAPID_PRIVATE: "malformed" }, sub, {}],
    [env, { ...sub, p256dh: "bad" }, {}],
    [env, sub, { aps: { alert: { body: "x".repeat(4000) } } }],
  ]) { const r = await sendWebPush(e, subscription, payload); assert.equal(r.retry, undefined); assert.equal(r.ok, false); }
  assert.equal(calls, 0);
  for (const status of [401, 403, 404, 410]) { globalThis.fetch = async () => new Response(null, { status }); assert.equal((await sendWebPush(env, sub, {})).drop, true); }
  for (const status of [429, 500]) { globalThis.fetch = async () => new Response(null, { status }); assert.equal((await sendWebPush(env, sub, {})).retry, true); }
  globalThis.fetch = async () => { throw Error("network down"); }; assert.equal((await sendWebPush(env, sub, {})).retry, true);
});
test("error logs retain a cause and source location while redacting credentials", async () => {
  const failure = new Error(`query exploded Bearer ${auth} https://host.invalid/private?token=secret`);
  const env = makeEnv({}, { before: () => { throw failure; } });
  const original = console.error, logs = []; console.error = (...args) => logs.push(args.join(" "));
  try {
    assert.equal((await call(env, "GET", "/v1/price")).status, 500);
    assert.match(logs.join("\n"), /query exploded/); assert.match(logs.join("\n"), /web.test.js/);
    assert.ok(!logs.join("\n").includes(auth)); assert.ok(!logs.join("\n").includes("token=secret"));
  } finally { console.error = original; }
});
test("error logs redact our indexer's key and the FCM service account, its key a line at a time", () => {
  const line = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  const account = JSON.stringify({ type: "service_account", private_key_id: "k3y1d0123456789abcdef",
    private_key: `-----BEGIN PRIVATE KEY-----\n${line}\nAnotherLineOfTheKeyThatIsLongEnough==\n-----END PRIVATE KEY-----\n`,
    client_email: "push@prl-hub.iam.gserviceaccount.com" });
  const original = console.error, logs = []; console.error = (...args) => logs.push(args.join(" "));
  try {
    logError("x", new Error(`own index said no to blockbook-app-key-0123456789 / ${line} / k3y1d0123456789abcdef / push@prl-hub.iam.gserviceaccount.com`),
      { OWN_BLOCKBOOK_KEY: "blockbook-app-key-0123456789", FCM_SERVICE_ACCOUNT: account });
    const out = logs.join("\n");
    assert.match(out, /own index said no/);
    for (const secret of ["blockbook-app-key-0123456789", line, "k3y1d0123456789abcdef", "push@prl-hub.iam.gserviceaccount.com"]) assert.ok(!out.includes(secret), secret);
  } finally { console.error = original; }
});

test("error logs keep their numbers: short settings that share a secret's name are not redacted", () => {
  const original = console.error, logs = []; console.error = (...args) => logs.push(args.join(" "));
  try {
    logError("tick", new Error("D1 timeout after 1500 ms at 1792116000 with key s3cr3t-config-key-v1"),
      { ACCOUNT_CONFIG_KEY_VERSION: "1", PAY_ADDRESS_SINCE: "1792116000", ACCOUNT_CONFIG_KEY: "s3cr3t-config-key-v1", PRO_USD: "4.99" },
      new Request("https://x.invalid/", { headers: { cookie: "a=1; session=abcdefgh12345678" } }));
    const out = logs.join("\n");
    assert.match(out, /D1 timeout after 1500 ms at 1792116000/);
    assert.ok(!out.includes("s3cr3t-config-key-v1"));
  } finally { console.error = original; }
});

async function pushEnv() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    env: makeEnv({
      VAPID_PUBLIC: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
      VAPID_PRIVATE: jwk.d,
      VAPID_SUBJECT: "mailto:owner@example.com",
    }),
    pair,
  };
}
async function subscription(path = "one") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${path}`,
    keys: {
      p256dh: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
      auth: b64(new Uint8Array(16)),
    },
  };
}
test("webpush: RFC 8291 complete published encryption vector", async () => {
  const pub =
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const pair = {
    publicKey: await crypto.subtle.importKey(
      "raw",
      unb64(pub),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    ),
    privateKey: await importPair(
      pub,
      "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    ),
  };
  const body = await encrypt(
    unb64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    { keyPair: pair, salt: unb64("DGv6ra1nlYgDCS1FRnbzlw") },
  );
  assert.equal(
    b64(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});
test("webpush: VAPID JWT verifies with public key and endpoint audience", async () => {
  const { env, pair } = await pushEnv();
  const jwt = await vapid(env, "https://fcm.googleapis.com/fcm/send/test", T0);
  const [h, p, s] = jwt.split(".");
  assert.ok(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      unb64(s),
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
  const claims = JSON.parse(new TextDecoder().decode(unb64(p)));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, T0 + 43200);
});
test("webpush: strict endpoint whitelist and malformed curve keys", async () => {
  const sub = await subscription();
  assert.ok(await validateSubscription(sub));
  for (const host of [
    "attacker.test",
    "fcm.googleapis.com.attacker.test",
    "notify.windows.com",
    "127.0.0.1",
  ]) {
    assert.equal(
      await validateSubscription({ ...sub, endpoint: `https://${host}/push` }),
      null,
    );
  }
  assert.equal(
    await validateSubscription({
      ...sub,
      endpoint: "https://user:pass@fcm.googleapis.com/push",
    }),
    null,
  );
  assert.equal(
    await validateSubscription({
      ...sub,
      keys: { ...sub.keys, p256dh: b64(new Uint8Array(65)) },
    }),
    null,
  );
});
test("webpush: Pro gate, 10-device cap, APNs PUT conflict and expired subscription removal", async () => {
  const { env } = await pushEnv();
  setNow(T0);
  const sub = await subscription();
  const body = { subscription: sub, rules: [], watches: [] };
  assert.equal(
    (await call(env, "PUT", "/v1/web/push", body, headers)).status,
    403,
  );
  seed(env, true);
  for (let i = 0; i < 10; i++) {
    const r = await call(
      env,
      "PUT",
      "/v1/web/push",
      { ...body, subscription: { ...sub, endpoint: sub.endpoint + i } },
      await notificationHeaders(env, i),
    );
    assert.equal(r.status, 200);
  }
  assert.equal(
    (await call(env, "PUT", "/v1/web/push", body, await notificationHeaders(env, 10))).status,
    409,
  );
  const token = await sha256(sub.endpoint + 0);
  assert.equal(
    (await call(env, "PUT", `/v1/devices/${token}`, { rules: [] }, headers)).status,
    409,
  );
  globalThis.fetch = async () => new Response(null, { status: 410 });
  assert.equal(
    (await call(env, "POST", `/v1/devices/${token}/test`, undefined, headers)).status,
    502,
  );
  assert.equal(
    env.DB.one("SELECT 1 FROM webpush WHERE token = ?", token),
    null,
  );
});
test("webpush: a 403 on a one-shot price alert removes subscription, device and rules", async () => {
  const { env } = await pushEnv(); setNow(T0 + 60); seed(env, true);
  const sub = await subscription();
  const registered = await call(env, "PUT", "/v1/web/push", { subscription: sub, oneshot: true, rules: [{ id: "above", kind: "above", value: 0.01, enabled: true }], watches: [] }, headers);
  assert.equal(registered.status, 200);
  installFetch(); const upstream = globalThis.fetch; let pushes = 0;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith("https://fcm.googleapis.com/")) { pushes++; return new Response(null, { status: 403 }); } return upstream(url, init); };
  await tick(env); assert.equal(pushes, 1);
  for (const table of ["devices", "webpush", "rules", "deferred", "watches"]) assert.equal(env.DB.one(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
});
test("web Pro: $4.99 exact payment unlocks offline push; shared-address donations do not", async () => {
  const { env } = await pushEnv();
  Object.assign(env, { PAY_ADDRESS: addr, PRO_USD: "4.99", PAY_CONFIRMATIONS: "1" });
  setNow(T0);
  quote(env);
  const order = await (await createOrder(env, gid, "qa", () => 3817)).json();
  assert.equal(order.usd, 4.99);
  assert.equal(order.sats, 624381700);
  const request = { subscription: await subscription(), rules: [], watches: [{ id: "watch", pool: "AlphaPool", addr, after: 600 }] };
  blockbook([transaction(500000000, 10)]);
  await checkPayments(env);
  assert.equal((await call(env, "GET", "/v1/me", undefined, headers)).body.pro, false);
  assert.equal((await call(env, "PUT", "/v1/web/push", request, headers)).status, 403);
  const tx = transaction(order.sats, 0, "b".repeat(64));
  blockbook([tx]);
  setNow(T0 + 16);
  await checkPayments(env);
  assert.equal((await call(env, "GET", "/v1/me", undefined, headers)).body.pro, false);
  tx.confirmations = 1;
  setNow(T0 + 32);
  await checkPayments(env);
  assert.equal((await call(env, "GET", "/v1/me", undefined, headers)).body.pro, true);
  const result = await call(env, "PUT", "/v1/web/push", request, headers);
  assert.equal(result.status, 200);
  assert.equal(result.body.watches[0].after, 600);
});
test("webpush: one tick delivers identical rule to APNs and browser", async () => {
  const { env } = await pushEnv();
  setNow(T0);
  seed(env, true);
  const mocks = installFetch(),
    base = globalThis.fetch;
  const web = [];
  globalThis.fetch = async (url, init) =>
    String(url).startsWith("https://fcm.googleapis.com")
      ? (web.push(init), new Response(null, { status: 201 }))
      : base(url, init);
  const rules = [{ id: "rule", kind: "above", value: 0.7, enabled: true }];
  await register(env, tok(1), rules, { oneshot: true });
  const sub = await subscription();
  const r = await call(
    env,
    "PUT",
    "/v1/web/push",
    { subscription: sub, rules, watches: [] },
    headers,
  );
  assert.equal(r.status, 200);
  await tick(env);
  assert.equal(mocks.alerts().length, 1);
  assert.equal(web.length, 1);
  assert.equal(web[0].headers["Content-Encoding"], "aes128gcm");
  assert.equal(env.DB.one("SELECT SUM(enabled) n FROM rules").n, 0);
});

test("webpush: updating an existing subscription at the 10-device cap stays allowed", async () => {
  const { env } = await pushEnv();
  setNow(T0);
  seed(env, true);
  const sub = await subscription();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await call(
          env,
          "PUT",
          "/v1/web/push",
          {
            subscription: { ...sub, endpoint: sub.endpoint + i },
            rules: [],
            watches: [],
          },
          await notificationHeaders(env, i),
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await call(
        env,
        "PUT",
        "/v1/web/push",
        {
          subscription: { ...sub, endpoint: sub.endpoint + 0 },
          rules: [{ id: "x", kind: "above", value: 1 }],
          watches: [],
        },
        headers,
      )
    ).status,
    200,
  );
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM devices").n, 10);
});
test("webpush: quiet-hour deferred delivery works without APNs configuration", async () => {
  const { env } = await pushEnv();
  delete env.APNS_KEY;
  setNow(T0);
  seed(env, true);
  const sub = await subscription();
  const mocks = installFetch(),
    base = globalThis.fetch;
  let pushes = 0;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith("https://fcm.googleapis.com")
      ? (pushes++, new Response(null, { status: 201 }))
      : base(url, init);
  await call(
    env,
    "PUT",
    "/v1/web/push",
    {
      subscription: sub,
      rules: [{ id: "r", kind: "above", value: 0.7 }],
      watches: [],
      window: { start: 1, end: 2, tz: "UTC" },
    },
    headers,
  );
  await tick(env);
  assert.equal(pushes, 0);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM deferred").n, 1);
  setNow(T0 + 60);
  await tick(env);
  assert.equal(pushes, 1);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM deferred").n, 0);
  assert.equal(mocks.alerts().length, 0);
});
test("webpush: retry preserves one-shot rule; dead subscription is removed by tick", async () => {
  const { env } = await pushEnv();
  setNow(T0);
  seed(env, true);
  const sub = await subscription();
  installFetch();
  const base = globalThis.fetch;
  let status = 503;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith("https://fcm.googleapis.com")
      ? new Response(null, { status })
      : base(url, init);
  const r = await call(
    env,
    "PUT",
    "/v1/web/push",
    {
      subscription: sub,
      rules: [{ id: "r", kind: "above", value: 0.7 }],
      watches: [],
    },
    headers,
  );
  await tick(env);
  assert.equal(env.DB.one("SELECT enabled FROM rules").enabled, 1);
  status = 410;
  setNow(T0 + 60);
  await tick(env);
  assert.equal(
    env.DB.one("SELECT token FROM devices WHERE token = ?", r.body.token),
    null,
  );
  assert.equal(
    env.DB.one("SELECT token FROM webpush WHERE token = ?", r.body.token),
    null,
  );
});
test("address: an unused Blockbook address may omit transactions", async () => {
  const env = makeEnv();
  globalThis.fetch = async () =>
    Response.json({ balance: "0", unconfirmedBalance: "0", txs: 0 });
  const r = await call(env, "POST", "/v1/address", { addr });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.history, []);
});

test("webpush: offline watches share the existing outage engine", async () => {
  const { env } = await pushEnv();
  setNow(T0);
  seed(env, true);
  const sub = await subscription(),
    mocks = installFetch(),
    base = globalThis.fetch;
  let pushed = 0,
    online = true;
  globalThis.fetch = async (url, init) =>
    String(url).startsWith("https://fcm.googleapis.com")
      ? (pushed++, new Response(null, { status: 201 }))
      : base(url, init);
  mocks.pool = async () =>
    Response.json({
      last_seen: T0,
      workers: [{ name: "worker", online, time: T0 + 1 }],
    });
  const r = await call(
    env,
    "PUT",
    "/v1/web/push",
    {
      subscription: sub,
      rules: [],
      watches: [{ id: "watch", pool: "AlphaPool", addr, after: 600 }],
    },
    headers,
  );
  assert.equal(r.status, 200);
  await tick(env);
  assert.equal(pushed, 0);
  online = false;
  setNow(T0 + 660);
  await tick(env);
  assert.equal(pushed, 1);
  const out = await call(env, "GET", `/v1/devices/${r.body.token}`, undefined, headers);
  assert.equal(out.body.watches[0].checked_at, T0 + 660);
  setNow(T0 + 840);
  await tick(env);
  assert.equal(pushed, 1, "the same outage must not notify twice");
  online = true;
  setNow(T0 + 1020);
  await tick(env);
  assert.equal(pushed, 1, "recovery must be stable before notifying");
  setNow(T0 + 1080);
  await tick(env);
  assert.equal(pushed, 2, "one recovery notification follows the outage");
  setNow(T0 + 1260);
  await tick(env);
  assert.equal(pushed, 2, "the same recovery must not notify twice");
});
test("webpush: concurrent registrations cannot exceed the device cap", async () => {
  const { env } = await pushEnv();
  setNow(T0);
  seed(env, true);
  const sub = await subscription();
  const deviceHeaders = await Promise.all(Array.from({ length: 12 }, (_, i) => notificationHeaders(env, i)));
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      call(
        env,
        "PUT",
        "/v1/web/push",
        {
          subscription: { ...sub, endpoint: sub.endpoint + i },
          rules: [],
          watches: [],
        },
        deviceHeaders[i],
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 10);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM devices").n, 10);
});
test("web housekeeping: old budgets and unpaid orders pruned despite missing prices", async () => {
  const env = makeEnv();
  setNow(T0);
  globalThis.fetch = async () => new Response(null, { status: 500 });
  env.DB.raw
    .prepare("INSERT INTO kv (k,v,ts) VALUES ('pb:AlphaPool:old','1',?)")
    .run(T0 - 7200);
  env.DB.raw
    .prepare(
      "INSERT INTO orders (id,gid,usd,rate,sats,created_at,expires_at) VALUES ('old',?,5,.8,625000100,?,?)",
    )
    .run(gid, T0 - 31 * 86400, T0 - 31 * 86400 + 1800);
  await tick(env);
  // Scheduled network sampling can reserve a fresh Blockbook budget even if
  // the upstream fails. Housekeeping removes only expired reservations.
  assert.equal(env.DB.one("SELECT k FROM kv WHERE k LIKE 'pb:%' AND ts < ?", T0 - 3600), null);
  assert.equal(env.DB.one("SELECT id FROM orders"), null);
});
