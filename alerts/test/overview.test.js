import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseTable,
  parseNetwork,
  averageDifficulty,
  buildOverview,
  decodePoolHistory,
  payoutComparison,
  chainPoolRows,
  sharedSnapshot,
  WORK,
} from "../src/overview.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";
const fixture = (n) =>
  readFileSync(new URL(`../../Tests/Fixtures/${n}`, import.meta.url), "utf8");
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreNow();
  delete globalThis.caches;
});
const chain = () => JSON.parse(fixture("lordofpearls_public.json"));
const near = (a, b) =>
  assert.ok(
    Math.abs(a - b) < Math.max(1e-8, Math.abs(b) * 1e-12),
    `${a} != ${b}`,
  );
test("chain fallback: only attributed 24h pool blocks are joined; missing hashrate stays unknown", () => {
  const rows = chainPoolRows({ leaderboard: { window: 24, window_unit: "hours", top: [
    { blocks: 30, pool: { url: "https://prl.kryptex.network/", name: "Kryptex Pool" } },
    { blocks: 4, pool: { url: "https://prl.kryptex.network/" } },
    { blocks: 50, address: "unattributed" },
    { blocks: 2, pool: { url: "javascript:alert(1)" } },
  ] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Kryptex");
  assert.equal(rows[0].blocks, 34);
  assert.equal(rows[0].hashrate, null);
  assert.deepEqual(chainPoolRows({ leaderboard: { window: 168, top: [] } }), []);
});
test("history: delta decoding preserves gaps without resetting the running value", () => {
  const points = decodePoolHistory({ history_start: "1000", history_interval: 3600, history: [100, 10, -20, "x", 50, -5] });
  assert.deepEqual(points.map((p) => p.hashrate), [100, 110, 90, null, 140, 135]);
  assert.deepEqual(points.map((p) => p.ts), [1000, 4600, 8200, 11800, 15400, 19000]);
  assert.deepEqual(decodePoolHistory({ history_start: 1000, history_interval: -1, history: [100] }), []);
  assert.deepEqual(decodePoolHistory({ history: "unavailable" }), []);
});
test("real cost: public tariffs and block luck are never presented as settlement measurements", () => {
  for (const scheme of ["PPS", "PPS+", "FPPS", "PPLNS", "PROP", "SOLO", null])
    assert.equal(payoutComparison(scheme, 2, 100, 100, false, false).realFeePercent, null);
  assert.equal(payoutComparison("PPS", null, 100, 100, true, false).realFeePercent, null);
  assert.equal(payoutComparison("PPS", 2, 100, null, true, false).realFeePercent, null);
});
test("comparison: history joins domain aliases without overriding primary hashrate", () => {
  const [pool] = buildOverview([{ name: "Kryptex", url: "https://prl.kryptex.network/", hashrate: 300, fee: 2, blocks: 25, scheme: "PPS+" }],
    { hashrate: 1000, reward: 1, prlPerTHDay: .02 }, {
      mps: { data: [{ url: "https://pool.kryptex.com/prl", hashrate: 900, history_start: 1000, history_interval: 3600, history: [200, 10], hashrate_average_7d: 205, lastblocktime: "1200" }] },
      chain: { leaderboard: { recent_blocks: [{ time: 1400, pool: { url: "https://prl.kryptex.network/" } }, { time: 1500, pool: { url: "https://unrelated.example/" } }] },
        lifetime: { top: [{ blocks: 50, pool: { url: "https://prl.kryptex.network/" } }, { blocks: 10, pool: { url: "https://prl.kryptex.network/" } }, { blocks: 100, pool: { url: "https://unrelated.example/" } }] } },
    });
  assert.equal(pool.hashrate, 300);
  assert.deepEqual(pool.history.map((p) => p.hashrate), [200, 210]);
  assert.equal(pool.averageHashrate7d, 205);
  assert.equal(pool.lastBlockTime, 1400);
  assert.equal(pool.lifetimeBlocks, 60);
});
test("Fortune: two payout schemes share one hashrate and use the same daily work window", () => {
  const rows = buildOverview([{ name: "Pearl Fortune", url: "https://pearlfortune.org", hashrate: 3e15, blocks: 40, scheme: "PPS", fee: 5 }], null, {
    fortune: { pool_stats: { pool_fee_rate: .02, rolling_stats: [{ hours: 1, hashrate: 2e15 }, { hours: 24, hashrate: 1e15, total_coins: 80, expected_coins: 100, block_count: 25 }] } },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hashrate, 2e15);
  assert.deepEqual(rows[0].payouts.map((p) => [p.scheme, p.fee, p.grossPerPH]), [["PPS", 5, 100], ["PPLNS", 2, 80]]);
  assert.equal(rows[0].payouts[0].realFeePercent, null);
  assert.equal(rows[0].payouts[1].realFeePercent, null);
  assert.equal(rows[0].blocksSample, 25);
});
test("overview: recorded pool HTML locates columns by header, preserves missing and genuine zeros", () => {
  const rows = parseTable(fixture("lordofpearls_pools.html"));
  assert.ok(rows.length >= 5);
  assert.ok(rows.some((r) => r.hashrate > 1e15));
  const h =
    '<table class="section-table"><tr><th>Banner</th><th>Fee</th><th>Hashrate</th><th>Pool</th><th>Min payout</th><th>Payout</th><th>24H Blocks</th><th>Miners</th></tr><tr><td>Ad</td><td>0%</td><td>0 H/s</td><td><a href="https://akoyapool.com">Akoya</a></td><td>1 PRL</td><td>PPLNS</td><td>0</td><td>0</td></tr><tr><td></td><td>—</td><td>— 34s ago</td><td><a href="javascript:alert(1)">Unavailable</a></td><td>1</td><td>—</td><td>—</td><td>—</td></tr></table>';
  const [zero, unknown] = parseTable(h);
  assert.equal(zero.hashrate, 0);
  assert.equal(zero.fee, 0);
  assert.equal(zero.miners, 0);
  assert.equal(zero.scheme, "PPLNS");
  assert.equal(unknown.hashrate, null);
  assert.equal(unknown.miners, null);
  assert.equal(unknown.blocks, null);
  assert.equal(unknown.url, "");
  assert.deepEqual(parseTable("<table>changed</table>"), []);
});
test("network: 24h hashrate and per TH output share the Swift chain identity", () => {
  const o = chain(),
    n = parseNetwork(o);
  const bt = (o.leaderboard.window * 3600) / o.leaderboard.total_blocks;
  near(n.blockTime, bt);
  near(n.hashrate, (o.network.difficulty * WORK) / bt);
  near(n.prlPerTHDay, (n.reward * 86400) / ((n.hashrate * n.blockTime) / 1e12));
  const rows = buildOverview(
    [
      {
        name: "AlphaPool",
        url: "https://pearl.alphapool.tech/",
        hashrate: n.hashrate / 10,
        blocks: 30,
        fee: 1,
        scheme: "PPLNS",
      },
    ],
    n,
  );
  near(rows[0].share, 0.1);
  assert.equal(rows[0].trustworthy, true);
  assert.equal(parseNetwork({}), null);
});
test("difficulty: interpolate sparse sample at trailing edge rather than averaging interior values", () => {
  const t = 10 * 86400,
    o = {
      ts: t,
      network: { difficulty: 30 },
      lifetime: {
        hashrate_series: [
          { t: t - 2 * 86400, diff: 10 },
          { t: t, diff: 30 },
        ],
      },
    };
  near(averageDifficulty(o, 1), 25);
  assert.equal(averageDifficulty({ ...o, lifetime: {} }, 1), null);
});
test("comparison: HeroMiners bit shift, Kryptex authoritative PPS fee, low samples and SOLO excluded", () => {
  const network = { hashrate: 10e18, reward: 2000, prlPerTHDay: 0.02 };
  const base = (name, url, scheme = "PPLNS") => ({
    name,
    url,
    scheme,
    hashrate: 1e18,
    fee: 1,
    blocks: 40,
    miners: null,
  });
  const rows = buildOverview(
    [
      base("Kryptex", "https://prl.kryptex.network"),
      { ...base("HeroMiners", "https://pearl.herominers.com"), hashrate: null },
      base("Tiny", "https://tiny.test"),
      base("Solo", "https://solo.test", "SOLO"),
    ],
    network,
    {
      kryptex: { fee: 0.02, fee_type: "PPS+", miners: 9 },
      hero: { pool: { hashrate: 803000000 } },
    },
  );
  const k = rows.find((r) => r.name === "Kryptex");
  assert.equal(k.fee, 2);
  assert.equal(k.earningsPerPH, 20);
  assert.equal(k.trustworthy, false);
  assert.equal(k.feeFromPoolAPI, true);
  near(rows.find((r) => r.name === "HeroMiners").hashrate, 803000000 * 2 ** 32);
  assert.equal(rows.find((r) => r.solo).trustworthy, false);
  const small = buildOverview(
    [{ ...base("Tiny", "https://tiny.test"), blocks: 2 }],
    network,
  )[0];
  assert.equal(small.trustworthy, false);
  near(small.earningsPerPH, 4);
  const zero = buildOverview(
    [{ ...base("Zero", "https://zero.test"), blocks: 0 }],
    network,
  )[0];
  assert.equal(zero.earningsPerPH, 0);
});
test("comparison: unlisted and SOLO pools merged without duplicates or mixed-window winners", () => {
  const rows = buildOverview(
    [
      {
        name: "AlphaPool",
        url: "https://pearl.alphapool.tech/",
        hashrate: 1e18,
        fee: 1,
        blocks: 20,
        scheme: "PPLNS",
      },
    ],
    { hashrate: 10e18, reward: 2000, prlPerTHDay: 0.02 },
    {
      mps: {
        block_time_average: 200,
        data: [
          { url: "https://pearl.alphapool.tech", hashrate: 1e18 },
          {
            url: "https://www.f2pool.com",
            hashrate: 2e18,
            feetype: "PPS%1",
            blocks_1000: 40,
            fee: 1,
          },
          {
            url: "https://solo-prl.2miners.com",
            hashrate: 1e16,
            feetype: "SOLO%1",
            blocks_1000: 30,
            fee: 1,
          },
          {
            url: "https://another.test",
            hashrate: 1e16,
            blocks_1000: 30,
            fee: 0,
          },
        ],
      },
    },
  );
  assert.equal(rows.filter((r) => r.name === "AlphaPool").length, 1);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((r) => r.name === "F2Pool").pps, true);
  assert.equal(rows.find((r) => r.name === "F2Pool").earningsPerPH, 20);
  assert.equal(rows.find((r) => r.name === "another.test").trustworthy, false);
});
const mock = (env, { fail = false, fallback = false } = {}) => {
  const urls = [];
  globalThis.fetch = async (url) => {
    url = String(url);
    urls.push(url);
    if (fail || (fallback && url.includes("lordofpearls")))
      return new Response("down", { status: 503 });
    if (url.includes("/api/public")) return Response.json(chain());
    if (url.includes("lordofpearls"))
      return new Response(fixture("lordofpearls_pools.html"));
    if (url.includes("data.miningpoolstats"))
      return Response.json({
        time: T0,
        nethash_estimat: 1e19,
        poolshash: 8e18,
        block_time_average: 200,
        supply: { emission24: -1 },
        data: [
          {
            url: "https://www.f2pool.com",
            hashrate: 2e18,
            fee: 1,
            feetype: "PPS%1",
            blocks_1000: 20,
          },
        ],
      });
    if (url.includes("miningpoolstats"))
      return new Response('var last_time = "1790000000"');
    if (url.includes("kryptex"))
      return Response.json({ fee: 0.02, fee_type: "PPS+", block_reward: 2000 });
    return Response.json({ pool: { realHashrate: 3e18 } });
  };
  return urls;
};
test("overview API: public no-store, capped budgets, full comparison and no personal identity", async () => {
  setNow(T0);
  const env = makeEnv(),
    urls = mock(env);
  const r = await call(env, "GET", "/v1/pools");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(r.body.rows.length >= 5);
  assert.equal(urls.length, 7);
  const pplns = r.body.rows.find((row) => row.scheme === "PPLNS" && row.earningsPerPH != null && row.fee != null);
  assert.ok(pplns);
  assert.equal(pplns.payouts[0].realFeePercent, null); // A 24h snapshot cannot supply a five-day PPLNS estimate.
  assert.equal(pplns.payouts[0].realFeeEstimated, null);
  assert.equal(pplns.payouts[0].realFeePeriod, null);
  assert.equal(env.DB.rows("SELECT * FROM groups").length, 0);
  assert.ok(env.DB.rows("SELECT * FROM kv WHERE k LIKE 'pb:%'").length >= 4);
});
test("overview fallback: missing emission never treated as negative reward; own API supplies reward", async () => {
  setNow(T0);
  const env = makeEnv();
  mock(env, { fallback: true });
  const r = await call(env, "GET", "/v1/pools");
  assert.equal(r.status, 200);
  assert.equal(r.body.source, "miningpoolstats");
  assert.equal(r.body.network.reward, 2000);
  assert.ok(r.body.network.prlPerTHDay > 0);
  assert.equal(r.body.partial, true);
});
test("overview API: upstream failure and read limiter cannot fabricate successful empty rows", async () => {
  const env = makeEnv();
  mock(env, { fail: true });
  assert.equal((await call(env, "GET", "/v1/pools")).status, 502);
  env.RL_READ = { limit: async () => ({ success: false }) };
  assert.equal((await call(env, "GET", "/v1/pools")).status, 429);
});

test("shared source: API callers reuse the durable snapshot and refresh after five minutes", async () => {
  setNow(T0);
  const env = makeEnv(), urls = mock(env);
  const first = await call(env, "GET", "/v1/pools");
  assert.equal(first.body.schemaVersion, 1);
  setNow(T0 + 200);
  const next = await call(env, "GET", "/v1/pools");
  assert.equal(next.body.ts, first.body.ts);
  assert.equal(urls.length, 7);
  setNow(T0 + 301);
  const refreshed = await call(env, "GET", "/v1/pools");
  assert.equal(refreshed.body.ts, T0 + 301);
  assert.equal(urls.length, 14);
});
test("shared source: an upstream outage retains timestamped data, then expires it", async () => {
  setNow(T0);
  const env = makeEnv();
  mock(env);
  const first = await call(env, "GET", "/v1/pools");
  setNow(T0 + 301);
  mock(env, { fail: true });
  const stale = await call(env, "GET", "/v1/pools");
  assert.equal(stale.status, 200);
  assert.equal(stale.body.ts, first.body.ts);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.partial, true);
  assert.deepEqual(stale.body.rows, first.body.rows);
  setNow(T0 + 1801);
  assert.equal((await call(env, "GET", "/v1/pools")).status, 502);
});
test("shared source: independent regions share an atomic lease and an expired lease can recover", async () => {
  setNow(T0);
  const env = makeEnv();
  let builds = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const snapshot = { ok: true, schemaVersion: 1, ts: T0, rows: [{ id: "pool" }], network: null, stale: false, partial: true };
  const first = sharedSnapshot(env.DB, async () => { builds++; await gate; return snapshot; });
  // Wait until the first request owns the lease, simulating a second isolate.
  while (!env.DB.one("SELECT k FROM kv WHERE k = 'public:overview:lease:v1'")) await new Promise((resolve) => setImmediate(resolve));
  const second = sharedSnapshot(env.DB, async () => { builds++; throw new Error("duplicate"); });
  release();
  assert.deepEqual(await first, snapshot);
  assert.deepEqual(await second, { ...snapshot, stale: false });
  assert.equal(builds, 1);
  assert.equal(env.DB.one("SELECT k FROM kv WHERE k = 'public:overview:lease:v1'"), null);
  setNow(T0 + 301);
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES('public:overview:lease:v1','abandoned',?)").bind(T0).run();
  const next = await sharedSnapshot(env.DB, async () => ({ ...snapshot, ts: T0 + 301 }));
  assert.equal(next.ts, T0 + 301);
});

test("shared contract: Swift fixture is produced by the same public normalization as Web", () => {
  const contract = JSON.parse(fixture("shared_overview.json"));
  assert.deepEqual(JSON.parse(JSON.stringify(buildOverview(contract.inputs.rows, contract.snapshot.network, contract.inputs.extras))), contract.snapshot.rows);
});
