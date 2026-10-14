import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, setNow, restoreNow, T0, tok, liveTok, call, register, tick } from "./helpers.js";
import { BACKOFF_429, resetTokenCache } from "../src/apns.js";

afterEach(restoreNow);

const above = (id = "r", value = 0.5) => ({ id, kind: "above", value });
const ruleOf = (env, token, id = "r") => env.DB.one("SELECT enabled, armed, last_fired FROM rules WHERE token = ? AND id = ?", token, id);

async function fleet(env, n, rules = [above()]) {
  for (let i = 0; i < n; i++) assert.equal((await register(env, tok(i), rules)).status, 200);
}

test("tick: fired one-shot alerts are pushed once and switched off", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await fleet(env, 3);
  await tick(env);
  assert.equal(net.alerts().length, 3);
  assert.deepEqual(ruleOf(env, tok(0)), { enabled: 0, armed: 0, last_fired: T0 });
  setNow(T0 + 60);
  await tick(env);
  assert.equal(net.alerts().length, 3);
  assert.equal(net.alerts()[0].headers["apns-collapse-id"], "r");
});

test("tick: one-shot and repeating rules coexist, with reset and cooldown before the next push", async () => {
  setNow(T0);
  const net = installFetch(), env = makeEnv();
  const rules = [{ ...above("once"), repeat: false }, { ...above("repeat"), repeat: true }];
  await register(env, tok(0), rules);
  await tick(env);
  setNow(T0 + 60);
  await tick(env);
  assert.deepEqual(ruleOf(env, tok(0), "once"), { enabled: 0, armed: 0, last_fired: T0 });
  assert.deepEqual(ruleOf(env, tok(0), "repeat"), { enabled: 1, armed: 0, last_fired: T0 + 60 });
  const reply = (await call(env, "GET", `/v1/devices/${tok(0)}`)).body.rules;
  assert.deepEqual(reply.map((r) => [r.id, r.repeat, r.enabled]), [["once", false, false], ["repeat", true, true]]);
  await register(env, tok(0), rules); // An unchanged sync keeps the repeating rule disarmed.
  setNow(T0 + 120);
  await tick(env);
  assert.equal(net.alerts().length, 2);
  net.price = 0.48;
  setNow(T0 + 180);
  await tick(env);
  assert.equal(ruleOf(env, tok(0), "repeat").armed, 1);
  net.price = 0.8;
  setNow(T0 + 240);
  await tick(env);
  assert.equal(net.alerts().length, 2); // Reset, but still inside the cooldown.
  setNow(T0 + 1860);
  await tick(env);
  assert.equal(net.alerts().length, 3);
  assert.equal(net.alerts().at(-1).body.alert.id, "repeat");
  assert.equal(ruleOf(env, tok(0), "repeat").enabled, 1);
  assert.equal(ruleOf(env, tok(0), "once").enabled, 0);
});

test("tick: a frequency edit between evaluation and claim wins", async () => {
  setNow(T0);
  const net = installFetch();
  let editing = true;
  const env = makeEnv({}, { beforeBatch: async (stmts) => {
    if (editing && stmts.some((s) => s.sql.includes("AND enabled = 1 AND armed = 1"))) {
      editing = false;
      await register(env, tok(0), [{ ...above(), repeat: true }]);
    }
  } });
  await register(env, tok(0), [{ ...above(), repeat: false }]);
  await tick(env);
  assert.equal(net.alerts().length, 0);
  assert.equal(ruleOf(env, tok(0)).enabled, 1);
  setNow(T0 + 60);
  await tick(env);
  assert.equal(net.alerts().length, 1);
  assert.equal(ruleOf(env, tok(0)).enabled, 1);
});

test("tick: repeating rules stay enabled through quiet hours and delivery retries", async () => {
  setNow(T0);
  const net = installFetch(), env = makeEnv();
  await register(env, tok(0), [{ ...above(), repeat: true }], { window: { start: 540, end: 1380, tz: "Asia/Shanghai" } });
  await tick(env);
  assert.equal(net.alerts().length, 0);
  assert.equal(ruleOf(env, tok(0)).enabled, 1);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM deferred").n, 1);
  net.apns = () => ({ status: 500 });
  setNow(T0 + 3600);
  await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM deferred").n, 1);
  net.apns = () => ({ status: 200 });
  setNow(T0 + 3660);
  await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM deferred").n, 0);
  assert.equal(ruleOf(env, tok(0)).enabled, 1);
  setNow(T0 + 3720);
  await tick(env);
  assert.equal(net.alerts().length, 2);
});

test("tick (#1): a push that throws mid-tick costs only that push — no repeats of the delivered ones", async () => {
  setNow(T0);
  const net = installFetch();
  // The original failure: D1 hiccups while the provider token is saved.
  let failed = false;
  const env = makeEnv({}, {
    before: (sql) => {
      if (!failed && sql.includes("'apns_jwt'") && sql.startsWith("INSERT")) { failed = true; throw new Error("D1_ERROR: Network connection lost"); }
    },
  });
  await fleet(env, 5);
  // …and APNs drops the connection for one device.
  let once = true;
  net.apns = (c) => (c.token === tok(2) && once ? (once = false, Promise.reject(new TypeError("network"))) : { status: 200 });
  await tick(env);
  assert.equal(net.alerts().length, 5);
  assert.deepEqual(ruleOf(env, tok(0)), { enabled: 0, armed: 0, last_fired: T0 });
  assert.deepEqual(ruleOf(env, tok(2)), { enabled: 1, armed: 1, last_fired: null });   // put back
  setNow(T0 + 60);
  await tick(env);
  assert.deepEqual(net.alerts().map((c) => c.token).slice(5), [tok(2)]);             // only the one that failed
  assert.equal(ruleOf(env, tok(2)).enabled, 0);
});

test("tick (#1): an unusable APNs key leaves every rule armed for the next tick", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await fleet(env, 2);
  env.APNS_KEY = "-----BEGIN PRIVATE KEY-----\nbm9wZQ==\n-----END PRIVATE KEY-----";
  resetTokenCache();                       // registering minted a good token; make the tick sign anew
  env.DB.raw.exec("DELETE FROM kv WHERE k = 'apns_jwt'");
  await tick(env);                         // must not throw
  assert.equal(net.alerts().length, 0);
  assert.deepEqual(ruleOf(env, tok(0)), { enabled: 1, armed: 1, last_fired: null });
});

test("tick (#1): a hung APNs request doesn't let an overlapping tick push the same alerts again", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await fleet(env, 4);
  let release;
  const hang = new Promise((r) => { release = r; });
  net.apns = (c) => (c.token === tok(0) ? hang.then(() => ({ status: 200 })) : { status: 200 });
  const first = tick(env);
  while (net.alerts().length < 4) await new Promise((r) => setImmediate(r));
  assert.ok(net.alerts().every((c) => c.signal instanceof AbortSignal));   // every request has a deadline
  setNow(T0 + 60);
  await tick(env);                          // the next minute's cron, while the first still waits
  assert.equal(net.alerts().length, 4);
  release();
  await first;
  assert.equal(net.alerts().length, 4);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM rules WHERE enabled = 0 AND armed = 0").n, 4);
});

test("tick (#3): at most one push per device per tick — the rest go next minute", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  const rules = Array.from({ length: 20 }, (_, i) => above(`r${i}`, 0.5));
  assert.equal((await register(env, tok(1), rules)).status, 200);
  await tick(env);
  assert.equal(net.alerts().length, 1);
  setNow(T0 + 60);
  await tick(env);
  assert.equal(net.alerts().length, 2);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM rules WHERE armed = 1").n, 18);
});

test("tick (#3): tokens APNs never accepted share a small per-tick budget", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await fleet(env, 30);
  env.DB.raw.exec("UPDATE devices SET verified_at = NULL");
  await tick(env);
  assert.equal(net.alerts().length, 20);
  assert.ok(env.DB.one("SELECT verified_at FROM devices WHERE token = ?", net.alerts()[0].token).verified_at);   // proven now
  setNow(T0 + 60);
  await tick(env);
  assert.equal(net.alerts().length, 30);
});

test("tick (#7): a PUT from an app that hasn't seen the firing can't re-arm it", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await fleet(env, 1);
  await tick(env);
  setNow(T0 + 30);
  assert.equal((await register(env, tok(0), [{ ...above(), enabled: true, seen_fired: 0 }])).status, 200);
  assert.deepEqual(ruleOf(env, tok(0)), { enabled: 0, armed: 0, last_fired: T0 });
  setNow(T0 + 60);
  await tick(env);
  assert.equal(net.alerts().length, 1);
});

test("tick (#7): a rule edited between evaluation and claim is not pushed or disarmed", async () => {
  setNow(T0);
  const net = installFetch();
  let edit = true;
  const env = makeEnv({}, {
    beforeBatch: async (stmts) => {
      // Land the user's edit right before the tick commits its claims.
      if (edit && stmts.some((s) => s.sql.includes("AND enabled = 1 AND armed = 1"))) {
        edit = false;
        await register(env, tok(0), [above("r", 0.9)]);
      }
    },
  });
  await fleet(env, 1);
  await tick(env);
  assert.equal(net.alerts().length, 0);
  assert.deepEqual(ruleOf(env, tok(0)), { enabled: 1, armed: 1, last_fired: null });
  assert.equal(env.DB.one("SELECT value FROM rules").value, 0.9);
});

test("tick (#8): APNs verdicts — refused for good, transient, back off, dead token", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await fleet(env, 4);
  const verdicts = { [tok(0)]: { status: 400, reason: "BadTopic" }, [tok(1)]: { status: 503, reason: "ServiceUnavailable" },
                     [tok(2)]: { status: 429, reason: "TooManyRequests" }, [tok(3)]: { status: 410, reason: "Unregistered" } };
  net.apns = (c) => verdicts[c.token] || { status: 200 };
  await tick(env);
  assert.deepEqual(ruleOf(env, tok(0)), { enabled: 0, armed: 0, last_fired: T0 });   // not retried every minute
  assert.equal(ruleOf(env, tok(1)).armed, 1);                                         // retried next tick
  assert.equal(ruleOf(env, tok(2)).armed, 1);
  assert.equal(env.DB.one("SELECT retry_after FROM devices WHERE token = ?", tok(2)).retry_after, T0 + BACKOFF_429);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM devices WHERE token = ?", tok(3)).n, 0);
  assert.equal(ruleOf(env, tok(3)), null);

  net.apns = () => ({ status: 200 });
  const before = net.alerts().length;
  setNow(T0 + 60);
  await tick(env);
  assert.deepEqual(net.alerts().slice(before).map((c) => c.token), [tok(1)]);          // 429 device still waits
  setNow(T0 + BACKOFF_429 + 60);
  await tick(env);
  assert.deepEqual(net.alerts().slice(before + 1).map((c) => c.token), [tok(2)]);
});

test("tick: quiet hours queue the alert, the window start delivers it once", async () => {
  // Window 09:00–23:00 Shanghai; T0 is 08:00 there.
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  assert.equal((await register(env, tok(0), [above()], { window: { start: 540, end: 1380, tz: "Asia/Shanghai" } })).status, 200);
  await tick(env);
  assert.equal(net.alerts().length, 0);
  assert.equal(env.DB.one("SELECT fired_at FROM deferred").fired_at, T0);
  assert.equal((await call(env, "GET", `/v1/devices/${tok(0)}`)).body.rules[0].deferred, true);

  setNow(T0 + 3600);                                 // 09:00 — first push of the window; APNs hiccups
  net.apns = () => ({ status: 500 });
  await tick(env);
  assert.equal(net.alerts().length, 1);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM deferred").n, 1);   // kept for the next try
  net.apns = () => ({ status: 200 });
  setNow(T0 + 3660);
  await tick(env);
  assert.equal(net.alerts().length, 2);
  assert.match(net.alerts()[1].body.aps.alert.body, /quiet hours/);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM deferred").n, 0);
  setNow(T0 + 3720);
  await tick(env);
  assert.equal(net.alerts().length, 2);
});

test("tick (#11): live heartbeats go at low priority; a rotated token keeps the activity's 8 h", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  const put = (t, body) => call(env, "PUT", `/v1/live/${t}`, { env: "production", topic: "com.prl.wizard", ...body });
  assert.equal((await put(liveTok(1), {})).status, 200);
  assert.equal((await put(liveTok(2), { started_at: T0 - 8 * 3600 + 120 })).status, 200);   // rotated 2 min before 8 h
  assert.equal((await put(liveTok(3), { started_at: T0 - 99 * 3600 })).status, 200);        // nonsense → now
  await tick(env);
  const live = () => net.calls.filter((c) => c.headers["apns-push-type"] === "liveactivity");
  assert.deepEqual(live().map((c) => c.headers["apns-priority"]), ["10", "10", "10"]);
  setNow(T0 + 11 * 60);                              // same price, heartbeat due
  await tick(env);
  const beats = live().slice(3);
  assert.deepEqual(beats.map((c) => c.headers["apns-priority"]), ["5", "5"]);
  assert.ok(!beats.some((c) => c.token === liveTok(2)));                                   // past its 8 h
  net.price = 0.9;
  setNow(T0 + 12 * 60);
  await tick(env);
  assert.deepEqual(live().slice(5).map((c) => c.headers["apns-priority"]), ["10", "10"]);   // price moved
});

test("tick (#12): SafeTrade freshness by its own clock; an old last price can't veto a lone source", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  // A quote that reached us just now but was stamped 5 min ago is stale.
  env.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('safetrade', ?, ?)").run(JSON.stringify({ last: 0.7, at: T0 - 300 }), T0);
  await tick(env);
  assert.equal(env.DB.one("SELECT src FROM prices").src, "median");

  // Two hours of silence, then only CoinEx answers, 50% higher.
  const env2 = makeEnv();
  env2.DB.raw.prepare("INSERT INTO prices (ts, usd, src) VALUES (?, 0.5, 'median')").run(T0 - 7200);
  globalThis.fetch = ((orig) => async (url, init) => (new URL(url).hostname === "api.coinex.com" ? orig(url, init) : new Response("", { status: 503 })))(globalThis.fetch);
  net.price = 0.75;
  await tick(env2);
  assert.equal(env2.DB.one("SELECT usd FROM prices WHERE ts = ?", T0).usd, 0.75);
  // A recent last price still vetoes the same jump.
  const env3 = makeEnv();
  env3.DB.raw.prepare("INSERT INTO prices (ts, usd, src) VALUES (?, 0.5, 'median')").run(T0 - 600);
  await tick(env3);
  assert.equal(env3.DB.one("SELECT count(*) AS n FROM prices").n, 1);
});

test("tick (#9): hourly prune forgets devices unseen for 90 days and old test throttles", async () => {
  setNow(T0 - 100 * 86400);
  installFetch();
  const env = makeEnv();
  await fleet(env, 2);
  setNow(T0 - 3600);
  await call(env, "GET", `/v1/devices/${tok(1)}`);                   // tok(1)'s app checks in
  env.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES (?, '', ?)").run(`test:${tok(1)}`, T0 - 7200);
  setNow(T0);                                                          // T0 is on the hour
  await tick(env);
  assert.deepEqual(env.DB.rows("SELECT token FROM devices").map((r) => r.token), [tok(1)]);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM rules WHERE token = ?", tok(0)).n, 0);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM kv WHERE k LIKE 'test:%'").n, 0);
});
