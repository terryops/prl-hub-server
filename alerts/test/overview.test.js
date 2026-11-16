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
  mpsDataURL,
  sharedSnapshot,
  perynPool, perynBlocks24h,
  perynHistory,
  WORK,
} from "../src/overview.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";
import worker from "../src/index.js";
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
test("chain identity: a verified payout address names Jetski's blocks; other bare addresses stay unattributed", () => {
  const pearlski = "prl1pgr2znrzz8nwu2lrw4phrzaqqa8ukt76qsqc29wxgcwgalanur7zsk8w070";
  const rows = chainPoolRows({ leaderboard: { window: 24, window_unit: "hours", top: [
    { blocks: 12, address: pearlski }, { blocks: 11, address: "prl1punknown" }, { blocks: 3, address: "__proto__" }] } });
  assert.deepEqual(rows.map((r) => [r.name, r.url, r.blocks]), [["Jetski", "https://pearl.jetskipool.ai/", 12]]);
  // The miningpoolstats row for the same pool gains the chain's lifetime count and last block.
  const [pool] = buildOverview([], { hashrate: 1000, reward: 1, prlPerTHDay: .02 }, {
    mps: { block_time_average: 180, data: [{ pool_id: "jetskipool.ai", url: "https://pearl.jetskipool.ai/", hashrate: 30, blocks_1000: 25, fee: 1, feetype: "PPLNS" }] },
    chain: { leaderboard: { recent_blocks: [{ time: 1400, miner: pearlski }, { time: 1500, miner: "prl1punknown" }] },
      lifetime: { top: [{ blocks: 1032, address: pearlski }, { blocks: 5000, address: "prl1punknown" }] } },
  });
  assert.equal(pool.name, "Jetski");
  assert.equal(pool.lifetimeBlocks, 1032);
  assert.equal(pool.lastBlockTime, 1400);
});
test("PearlHash: PROP by the hour at its site's 1% fee, whatever the pool table says", () => {
  // Its own account API, 2026-10-31: each hour's blocks go to that hour's shares. Its site: "1% pool fee".
  const [pool] = buildOverview([], { hashrate: 1000, reward: 1, prlPerTHDay: .02 }, {
    mps: { block_time_average: 180, data: [{ pool_id: "pearlhash.xyz", url: "https://pearlhash.xyz/", hashrate: 30, blocks_1000: 25, fee: 0.5, feetype: "" }] },
  });
  assert.equal(pool.name, "PearlHash");
  assert.equal(pool.fee, 1);
  assert.deepEqual(pool.payouts.map((p) => [p.scheme, p.fee]), [["PROP", 1]]);
});
test("miningpoolstats: the data file's host comes from the page's preload link", () => {
  // The page on 2026-10-25: the pool data on server.miningpoolstats.stream, the old host only in comments
  // for the price and history files (data.miningpoolstats.stream answers 403).
  const page = 'var last_time = "1792934212";var page = "pearl";' +
    '<link rel="preload" href="https://server.miningpoolstats.stream/data/pearl.js?t=1792934212" as="fetch">' +
    '<!-- <link rel="preload" href="https://data.miningpoolstats.stream/data/price/pearl.js?t=1792934212" as="fetch"> -->' +
    '<!-- <link rel="preload" href="https://data.miningpoolstats.stream/data/history/pearl.js?t=1792934212" as="fetch"> -->';
  assert.equal(mpsDataURL(page), "https://server.miningpoolstats.stream/data/pearl.js?t=1792934212");
  // Another miningpoolstats host is followed; anything else is not, and without a link the current host is used.
  assert.equal(mpsDataURL('var last_time = "5"; href="https://Data2.MiningPoolStats.stream/data/pearl.js?t=5"'),
    "https://data2.miningpoolstats.stream/data/pearl.js?t=5");
  assert.equal(mpsDataURL('var last_time = "5"; href="https://evil.example/x.miningpoolstats.stream/data/pearl.js?t=5"'),
    "https://server.miningpoolstats.stream/data/pearl.js?t=5");
  assert.equal(mpsDataURL('var last_time = "5"; href="https://miningpoolstats.stream.evil.example/data/pearl.js?t=5"'),
    "https://server.miningpoolstats.stream/data/pearl.js?t=5");
  assert.equal(mpsDataURL('var last_time = "5"'), "https://server.miningpoolstats.stream/data/pearl.js?t=5");
  assert.equal(mpsDataURL("<html>no time</html>"), null);
});

test("chain identity: F2Pool's address, checked by its coinbase tag, names its blocks for its miningpoolstats row", () => {
  const f2 = "prl1prsmhnjnphz4ll4v9lhg8nhr0tv3v7g8sl6qkuyqmnwkq7rhs9c2qqak0rr";
  const rows = chainPoolRows({ leaderboard: { window: 24, window_unit: "hours", top: [{ blocks: 8, address: f2 }] } });
  assert.deepEqual(rows.map((r) => [r.name, r.url, r.blocks]), [["F2Pool", "https://www.f2pool.com/", 8]]);
  const [pool] = buildOverview([], { hashrate: 1000, reward: 1, prlPerTHDay: .02 }, {
    mps: { block_time_average: 180, data: [{ pool_id: "f2pool.com", url: "https://www.f2pool.com/", hashrate: 30, blocks_1000: 25, fee: 1, feetype: "PPS" }] },
    chain: { leaderboard: { recent_blocks: [{ time: 1400, miner: f2 }, { time: 1500, miner: "prl1punknown" }] },
      lifetime: { top: [{ blocks: 228, address: f2 }, { blocks: 5000, address: "prl1punknown" }] } },
  });
  assert.equal(pool.name, "F2Pool");
  assert.equal(pool.lifetimeBlocks, 228);
  assert.equal(pool.lastBlockTime, 1400);
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
  // No fee-rate reply: PPS keeps the fallback figure.
  assert.deepEqual(rows[0].payouts.map((p) => [p.scheme, p.fee, p.grossPerPH]), [["PPS", 4, 100], ["PPLNS", 2, 80]]);
  assert.equal(rows[0].payouts[0].realFeePercent, null);
  assert.equal(rows[0].payouts[1].realFeePercent, null);
  assert.equal(rows[0].blocksSample, 25);
  assert.ok(rows[0].payouts.every((p) => p.mergeBonus === undefined));
});
const prlscanReply = (items, age = 60) => ({ updated_at: new Date((T0 - age) * 1000).toISOString(), items });
test("prlscan: its 24h block count replaces the table's wherever it lists the pool", () => {
  setNow(T0);
  const scan = prlscanReply([
    { slug: "kryptex", website_url: "https://pool.kryptex.com/prl", blocks_24h: 203 },
    { slug: "f2pool", website_url: "https://www.f2pool.com/#prl", blocks_24h: 15 },
    { slug: "k1pool", website_url: "https://k1pool.com/pool/pearl", blocks_24h: 0 },
    { slug: "pearlskipool", website_url: "https://pearl.jetskipool.ai/", blocks_24h: 6 },
    { slug: "bad", website_url: "https://broken.example/", blocks_24h: -1 },
    { slug: "twin-a", website_url: "https://a.twin.example/", blocks_24h: 4 },
    { slug: "twin-b", website_url: "https://a.twin.example/b", blocks_24h: 5 },
  ]);
  const table = [
    { name: "Kryptex", url: "https://prl.kryptex.network/", hashrate: 4e19, fee: 3, blocks: 202, scheme: "PPS+" },
    { name: "k1pool.com", url: "https://k1pool.com/pool/pearl", hashrate: 1e16, fee: 1, blocks: 1, scheme: "PPLNS" },
    { name: "k1pool.com", url: "https://k1pool.com/pool/pearlsolo", hashrate: 1e16, fee: 1, blocks: 2, scheme: "SOLO" },
    { name: "Unlisted", url: "https://unlisted.example/", hashrate: 1e17, fee: 1, blocks: 3, scheme: "PPLNS" },
    { name: "Broken", url: "https://broken.example/", hashrate: 1e17, fee: 1, blocks: 7, scheme: "PPLNS" },
    { name: "Twin", url: "https://a.twin.example/", hashrate: 1e17, fee: 1, blocks: 8, scheme: "PPLNS" },
  ];
  const mps = { block_time_average: 200, data: [
    { url: "https://www.f2pool.com", hashrate: 2e18, fee: 1, feetype: "PPLNS", blocks_1000: 25 },
    { url: "https://pearl.jetskipool.ai", hashrate: 1e18, fee: 1, feetype: "PPLNS", blocks_1000: 15 },
  ] };
  const network = { reward: 2000, hashrate: 8e19, prlPerTHDay: 0.02, ts: T0 };
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, [r.blocksPerDay, r.blocksSample, r.sampleDays, r.blocksSource ?? null, r.source]]));
  const rows = buildOverview(table, network, { mps, prlscan: scan });
  const days = 1000 * 200 / 86400;
  assert.deepEqual(by(rows), {
    // Another host, the same pool (Kryptex), and miningpoolstats' 1000-block rows take prlscan's 24h too.
    Kryptex: [203, 203, 1, "prlscan", "lordofpearls"],
    F2Pool: [15, 15, 1, "prlscan", "miningpoolstats"],
    Jetski: [6, 6, 1, "prlscan", "miningpoolstats"],
    "k1pool.com": [0, 0, 1, "prlscan", "lordofpearls"],
    // A SOLO row's blocks pay its miners, not the pool's address.
    "k1pool.com SOLO": [2, 2, 1, null, "lordofpearls"],
    // Not listed, a count that isn't one, two entries on one host: the table's own.
    Unlisted: [3, 3, 1, null, "lordofpearls"],
    Broken: [7, 7, 1, null, "lordofpearls"],
    Twin: [8, 8, 1, null, "lordofpearls"],
  });
  // The 24h yield follows the count it shows.
  const f2 = rows.find((r) => r.name === "F2Pool");
  near(f2.earningsPerPH, 15 * 2000 / (2e18 / 1e15));
  // No reply, a stale one or one from the future: every row keeps the table's count.
  for (const bad of [null, {}, prlscanReply(scan.items, 1801), prlscanReply(scan.items, -301), { ...scan, items: null }, { ...scan, updated_at: "soon" }]) {
    const r = by(buildOverview(table, network, { mps, prlscan: bad }));
    assert.deepEqual([r.Kryptex, r.F2Pool], [[202, 202, 1, null, "lordofpearls"], [25 / days, 25, days, null, "miningpoolstats"]], JSON.stringify(bad));
  }
});
test("prlscan: Pearl Fortune shows prlscan's count while its yield stays its own day's coins", () => {
  setNow(T0);
  const fortune = { pool_stats: { pool_fee_rate: .02, rolling_stats: [{ hours: 1, hashrate: 2e15 }, { hours: 24, hashrate: 1e15, total_coins: 80, expected_coins: 100, block_count: 25 }] } };
  const table = [{ name: "Pearl Fortune", url: "https://pearlfortune.org", hashrate: 3e15, blocks: 40, scheme: "PPS", fee: 5 }];
  const [own] = buildOverview(table, null, { fortune });
  const [scanned] = buildOverview(table, null, { fortune, prlscan: prlscanReply([{ website_url: "https://pearlfortune.org", blocks_24h: 41 }]) });
  assert.deepEqual([own.blocksPerDay, own.blocksSample, "blocksSource" in own], [25, 25, false]);
  assert.deepEqual([scanned.blocksPerDay, scanned.blocksSample, scanned.sampleDays, scanned.blocksSource], [41, 41, 1, "prlscan"]);
  assert.deepEqual(scanned.payouts.map((p) => [p.scheme, p.grossPerPH]), own.payouts.map((p) => [p.scheme, p.grossPerPH]));
});
test("Fortune: the PPS fee comes from its fee-rate API; nonsense keeps the fallback", () => {
  const ppsFee = (fortuneFees) => buildOverview([{ name: "Pearl Fortune", url: "https://pearlfortune.org", hashrate: 3e15, blocks: 40 }], null, {
    fortune: { pool_stats: { pool_fee_rate: .02, rolling_stats: [] } }, fortuneFees,
  })[0].payouts.map((p) => [p.scheme, p.fee]);
  assert.deepEqual(ppsFee({ pool_fee_rate: .02, pps_fee_rate: .04 }), [["PPS", 4], ["PPLNS", 2]]);
  assert.deepEqual(ppsFee({ pps_fee_rate: .035 }), [["PPS", 3.5], ["PPLNS", 2]]);
  assert.deepEqual(ppsFee({ pps_fee_rate: .05 }), [["PPS", 5], ["PPLNS", 2]]);
  for (const bad of [null, {}, { pps_fee_rate: null }, { pps_fee_rate: 1.5 }, { pps_fee_rate: -0.01 }, { pps_fee_rate: "x" }])
    assert.deepEqual(ppsFee(bad), [["PPS", 4], ["PPLNS", 2]], JSON.stringify(bad));
});
test("F2Pool: its NOCK merge-mining bonus rides on its payout as a label, yield and fee untouched", () => {
  const rows = buildOverview([], { reward: 2000, hashrate: 1e19, prlPerTHDay: 0.02, ts: 1 }, {
    mps: { block_time_average: 200, data: [
      { url: "https://www.f2pool.com", hashrate: 2e18, fee: 1, feetype: "PPS%1", blocks_1000: 20 },
      { url: "https://solo.f2pool.com", hashrate: 1e17, fee: 1, feetype: "SOLO", blocks_1000: 1 },
      { url: "https://another.test", hashrate: 1e16, blocks_1000: 30, fee: 0 },
    ] },
  });
  const f2 = rows.find((r) => r.name === "F2Pool");
  assert.deepEqual(f2.payouts.map((p) => [p.scheme, p.fee, p.mergeBonus]), [["PPS", 1, { coin: "NOCK", minPercent: 1, maxPercent: 2 }]]);
  assert.equal(f2.payouts[0].grossPerPH, 20);
  assert.ok(rows.filter((r) => r !== f2).every((r) => r.payouts.every((p) => p.mergeBonus === undefined)), JSON.stringify(rows.map((r) => [r.name, r.solo])));
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
test("comparison: HeroMiners takes its scheme and fee from its own config; SOLO and bad values keep the table's", () => {
  const network = { hashrate: 10e18, reward: 2000, prlPerTHDay: 0.02 };
  const hero = (scheme = "PPLNS", extra = {}) => ({ name: "HeroMiners", url: "https://pearl.herominers.com", scheme,
    hashrate: 1e18, fee: 1, blocks: 40, miners: null, ...extra });
  const row = (config, input = hero()) => buildOverview([input], network, { hero: { config, pool: {} } })[0];
  const prop = row({ rewardScheme: "prop", fee: 0 });
  assert.equal(prop.scheme, "PROP"); assert.equal(prop.fee, 0); assert.equal(prop.feeFromPoolAPI, true);
  assert.deepEqual([prop.payouts[0].scheme, prop.payouts[0].fee], ["PROP", 0]);
  assert.equal(prop.pps, false);
  for (const config of [undefined, {}, { rewardScheme: "", fee: "x" }, { rewardScheme: 7, fee: -1 }, { fee: 101 }]) {
    const kept = row(config);
    assert.deepEqual([kept.scheme, kept.fee, kept.feeFromPoolAPI], ["PPLNS", 1, false]);
  }
  const solo = row({ rewardScheme: "prop", fee: 0 }, hero("SOLO", { url: "https://pearl.herominers.com/solo" }));
  assert.deepEqual([solo.scheme, solo.fee], ["SOLO", 1]);
});
test("comparison: Lucky Pool takes its payout and fee from its own config; SOLO and bad values keep the table's", () => {
  // Its /api/stats on 2026-11-02: config.paymentMode "prop", fee 1, while the pool table said PPLNS.
  const network = { hashrate: 10e18, reward: 2000, prlPerTHDay: 0.02 };
  const lucky = (scheme = "PPLNS", extra = {}) => ({ name: "Lucky Pool", url: "https://pearl.luckypool.io", scheme,
    hashrate: 1e18, fee: 2, blocks: 40, miners: null, ...extra });
  const row = (config, input = lucky()) => buildOverview([input], network, { lucky: { config, pool: {} } })[0];
  const prop = row({ paymentMode: "prop", fee: 1 });
  assert.deepEqual([prop.scheme, prop.fee, prop.feeFromPoolAPI, prop.pps], ["PROP", 1, true, false]);
  assert.deepEqual([prop.payouts[0].scheme, prop.payouts[0].fee], ["PROP", 1]);
  assert.deepEqual([row({ paymentMode: " PPLNS " }).scheme, row({ paymentMode: "pplns" }).fee], ["PPLNS", 2]);
  for (const config of [undefined, {}, { paymentMode: "", fee: "x" }, { paymentMode: 7, fee: -1 }, { paymentMode: "solo", fee: 101 }]) {
    const kept = row(config);
    assert.deepEqual([kept.scheme, kept.fee, kept.feeFromPoolAPI], ["PPLNS", 2, false]);
  }
  const solo = row({ paymentMode: "prop", fee: 1 }, lucky("SOLO", { url: "https://pearl.luckypool.io/solo" }));
  assert.deepEqual([solo.scheme, solo.fee], ["SOLO", 2]);
  // HeroMiners' config is not read for Lucky Pool, nor Lucky Pool's for HeroMiners.
  assert.equal(buildOverview([lucky()], network, { hero: { config: { rewardScheme: "prop", fee: 0 }, pool: {} } })[0].scheme, "PPLNS");
});
// app.peryn.ai/api/pool/live on 2026-11-02, trimmed: no block found yet.
const perynLive = (pool = {}, blocks = {}) => ({
  network: "mainnet",
  pool: { hashrate: { macsPerSecond: 47454568246548616, windowSeconds: 600, unit: "H/s (pearld CalcWork)" },
    shareOfNetwork: 0.00058, feePct: 1, scheme: "PPLNS", activeWorkersLastHour: 142, minersLastHour: 35,
    luck30d: null, fpps: { active: true, feePct: 1 }, ...pool },
  networkStats: { difficulty: 51250567.95, height: 137075, hashrate: 82053867713851180000 },
  blocks: { found: 0, byStatus: { submitted: 0, pending: 0, mature: 0, orphaned: 0, rejected: 0 }, recent: [], ...blocks },
});
test("Peryn: its own API adds a row with PPS+ and PPLNS at its own fees; no block yet is 0, not unknown", () => {
  setNow(T0);
  const network = { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02, difficulty24h: 51e6 };
  const rows = buildOverview([{ name: "Kryptex", url: "https://prl.kryptex.network/", hashrate: 38e18, blocks: 230, fee: 3, scheme: "PPS+" }],
    network, { peryn: perynLive() });
  const pool = rows.find((r) => r.name === "Peryn");
  assert.equal(rows.length, 2);
  assert.deepEqual([pool.id, pool.url, pool.hashrate, pool.miners, pool.fee, pool.scheme, pool.pps, pool.solo],
    ["https://peryn.ai/", "https://peryn.ai/", 47454568246548616, 35, 1, "PPLNS", false, false]);
  near(pool.share, 47454568246548616 / 82e18);
  assert.deepEqual([pool.blocksPerDay, pool.blocksSample, pool.lifetimeBlocks, pool.lastBlockTime], [0, 0, 0, null]);
  assert.deepEqual([pool.source, pool.hashFromPoolAPI, pool.feeFromPoolAPI, pool.trustworthy], ["pool", true, true, false]);
  const theory = 2200 * 86400 * 1e15 / (51e6 * WORK);
  assert.deepEqual(pool.payouts.map((p) => [p.scheme, p.fee, p.estimated, p.solo]), [["PPS+", 1, true, false], ["PPLNS", 1, true, false]]);
  near(pool.payouts[0].grossPerPH, theory);
  assert.equal(pool.payouts[1].grossPerPH, 0);
  // Ranked by hashrate with the rest.
  assert.deepEqual(rows.map((r) => r.name), ["Kryptex", "Peryn"]);
});
test("Peryn: when its 10 listed blocks all fall inside the day, the older hours come from `hourly` (2026-11-09: 15, not 10)", () => {
  // app.peryn.ai/api/pool/live at 2026-11-09 14:36:54 UTC: the list reaches back to 18:42 yesterday.
  const t = Date.parse("2026-11-09T14:36:54Z") / 1000;
  const listed = ["13:05", "10:07", "06:29", "05:21", "00:25"].map((h) => `2026-11-09T${h}:00Z`)
    .concat(["23:58", "21:40", "20:31", "19:12", "18:42"].map((h) => `2026-11-08T${h}:00Z`));
  const recent = listed.map((foundAt, i) => ({ height: 140694 - i, foundAt, status: i < 2 ? "pending" : "mature" }));
  const perHour = [1, 3, 1, 0, 1, 2, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0]; // 14:00 yesterday … 14:00 today
  const start = Date.parse("2026-11-08T14:00:00Z");
  const hourly = perHour.map((blocks, i) => ({ hour: new Date(start + i * 3600_000).toISOString().replace(".000", ""), hashrate: 3e18, blocks }));
  // 10 listed + 15:00–17:59 yesterday (3 + 1 + 0); the 14:00 hour is mostly before the day began.
  assert.equal(perynBlocks24h({ recent }, hourly, t), 14);
  assert.equal(perynPool({ ...perynLive(), blocks: { found: 49, byStatus: { orphaned: 2 }, recent }, hourly }, t).blocks, 14);
  // An hour that held more blocks than the list shows of it: the unlisted ones count too.
  assert.equal(perynBlocks24h({ recent }, hourly.map((h, i) => i === 4 ? { ...h, blocks: 2 } : h), t), 15);
  // A list that reaches back a whole day is exact on its own; without hours, the listed day is all there is.
  assert.equal(perynBlocks24h({ recent: recent.slice(0, 3) }, hourly, Date.parse("2026-11-09T14:00:00Z") / 1000 + 86400), 0);
  assert.equal(perynBlocks24h({ recent }, undefined, t), 10);
  assert.equal(perynBlocks24h({ recent }, [{ hour: "bad", blocks: 9 }], t), 10);
});
test("Peryn: its listed blocks count by foundAt over 24h, orphaned and rejected left out", () => {
  setNow(T0);
  const at = (s) => new Date(s * 1000).toISOString();
  const o = perynLive({}, { found: 5, byStatus: { submitted: 0, pending: 2, mature: 1, orphaned: 1, rejected: 1 }, recent: [
    { height: 137100, foundAt: at(T0 - 600), status: "pending" },
    { height: 137090, foundAt: at(T0 - 3600), status: "orphaned" },
    { height: 137080, foundAt: at(T0 - 7200), status: "pending" },
    { height: 137000, foundAt: at(T0 - 2 * 86400), status: "mature" },
    { height: 136990, foundAt: at(T0 - 3 * 86400), status: "rejected" },
    { foundAt: "soon" }, { foundAt: at(T0 + 3600) }, null,
  ] });
  const p = perynPool(o);
  assert.deepEqual([p.blocks, p.lifetimeBlocks, p.lastBlockTime], [2, 3, T0 - 600]);
  const [row] = buildOverview([], { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02 }, { peryn: o });
  assert.deepEqual([row.blocksPerDay, row.lifetimeBlocks, row.lastBlockTime], [2, 3, T0 - 600]);
  near(row.payouts[1].grossPerPH, 2 * 2200 / (47454568246548616 / 1e15));
  // No list at all: a pool that says it found none has 0, anything else is unknown.
  assert.equal(perynPool(perynLive({}, { recent: undefined })).blocks, 0);
  assert.equal(perynPool(perynLive({}, { found: 4, recent: undefined })).blocks, null);
  assert.equal(perynPool(perynLive({}, { found: 1, byStatus: { orphaned: 2 } })).lifetimeBlocks, null);
});
test("Peryn: terms it doesn't state are left out; a reply without a hashrate adds no row", () => {
  setNow(T0);
  // PPS+ switched off: PPLNS alone.
  assert.deepEqual(perynPool(perynLive({ fpps: { active: false, feePct: 1 } })).ppsFee, null);
  const [pplns] = buildOverview([], { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02 }, { peryn: perynLive({ fpps: null }) });
  assert.deepEqual(pplns.payouts.map((p) => [p.scheme, p.fee]), [["PPLNS", 1]]);
  // Only PPS+: a PPS row at that fee.
  const [pps] = buildOverview([], { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02 }, { peryn: perynLive({ scheme: null, feePct: 2, fpps: { active: true, feePct: 0.5 } }) });
  assert.deepEqual([pps.scheme, pps.fee, pps.pps, pps.payouts.length], ["PPS+", 0.5, true, 1]);
  // Nonsense fees are unknown, never 0.
  const odd = perynPool(perynLive({ feePct: -1, fpps: { active: true, feePct: "x" } }));
  assert.deepEqual([odd.fee, odd.ppsFee, odd.miners], [null, null, 35]);
  for (const o of [null, {}, "x", { pool: {} }, perynLive({ hashrate: { macsPerSecond: 0 } }), perynLive({ hashrate: 5e16 })])
    assert.deepEqual(buildOverview([], { hashrate: 82e18, reward: 2200 }, { peryn: o }), []);
});
test("Peryn: Founding Miner fees ride on its payouts — open with the closing day, then closed; fee, yield and other pools untouched", () => {
  setNow(T0);
  const network = { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02 };
  const rows = (perynLaunch) => buildOverview([{ name: "Lucky Pool", url: "https://pearl.luckypool.io/", hashrate: 6e18, blocks: 30, fee: 1, scheme: "PPLNS" }],
    network, { peryn: perynLive(), perynLaunch });
  const terms = (row) => row.find((r) => r.name === "Peryn").payouts.map((p) => [p.scheme, p.founding, p.foundingClosed]);
  const open = rows({ launch: { mining: "live", foundingRegistration: "open" } });
  const peryn = open.find((r) => r.name === "Peryn");
  assert.deepEqual(terms(open), [["PPS+", { fee: 0.5, closes: "2026-11-08" }, undefined], ["PPLNS", { fee: 0, afterFP8Months: 6, closes: "2026-11-08" }, undefined]]);
  assert.deepEqual(peryn.payouts.map((p) => p.fee), [1, 1]);
  assert.equal(peryn.fee, 1);
  assert.deepEqual(open.find((r) => r.name === "Lucky Pool").payouts.map((p) => [p.founding, p.foundingClosed]), [[undefined, undefined]]);
  // Closed (2.1.11 apps read `founding` as open sign-ups, so it is left out): registered addresses keep the terms.
  const closedTerms = [["PPS+", undefined, { fee: 0.5 }], ["PPLNS", undefined, { fee: 0, afterFP8Months: 6 }]];
  const closed = rows({ launch: { foundingRegistration: "closed" } });
  assert.deepEqual(terms(closed), closedTerms);
  assert.deepEqual(closed.find((r) => r.name === "Peryn").payouts.map((p) => p.grossPerPH), peryn.payouts.map((p) => p.grossPerPH));
  // Unknown before the closing day: no terms.
  for (const launch of [null, {}, { launch: null }, { launch: { foundingRegistration: true } }])
    assert.deepEqual(terms(rows(launch)), [["PPS+", undefined, undefined], ["PPLNS", undefined, undefined]]);
  // 8 Nov is the last day; from 9 Nov 00:00 UTC closed whatever its API says or whether it answers.
  setNow(Date.UTC(2026, 10, 8, 23, 59, 59) / 1000);
  assert.equal(terms(rows({ launch: { foundingRegistration: "open" } }))[0][1].closes, "2026-11-08");
  setNow(Date.UTC(2026, 10, 9) / 1000);
  for (const launch of [{ launch: { foundingRegistration: "open" } }, { launch: { foundingRegistration: "closed" } }, null])
    assert.deepEqual(terms(rows(launch)), closedTerms);
  setNow(T0);
  // Only the schemes it names: PPLNS alone when PPS+ is off.
  const pplns = buildOverview([], network, { peryn: perynLive({ fpps: null }), perynLaunch: { launch: { foundingRegistration: "open" } } })[0];
  assert.deepEqual(pplns.payouts.map((p) => [p.scheme, p.founding]), [["PPLNS", { fee: 0, afterFP8Months: 6, closes: "2026-11-08" }]]);
});
test("Peryn: a pool table or miningpoolstats listing of it is not doubled", () => {
  setNow(T0);
  const network = { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02 };
  // Once the explorer's table lists it, that row keeps its 24h chain blocks and takes Peryn's own terms.
  const listed = buildOverview([{ name: "Peryn", url: "https://peryn.ai", hashrate: 5e16, blocks: 1, fee: 0, scheme: "PROP", miners: 40 }],
    network, { peryn: perynLive() });
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].hashrate, listed[0].blocksPerDay, listed[0].miners, listed[0].source, listed[0].hashFromPoolAPI],
    [5e16, 1, 40, "lordofpearls", false]);
  assert.deepEqual(listed[0].payouts.map((p) => [p.scheme, p.fee]), [["PPS+", 1], ["PPLNS", 1]]);
  // miningpoolstats under any of its hosts is the same pool.
  const mps = buildOverview([], network, { peryn: perynLive(), mps: { block_time_average: 300, data: [
    { pool_id: "peryn.ai", url: "https://pool.peryn.ai/", hashrate: 4e16, blocks_1000: 0, fee: 1, feetype: "PPLNS" }] } });
  assert.deepEqual(mps.map((r) => [r.name, r.source]), [["Peryn", "pool"]]);
  // Without its own API, nothing is made up.
  assert.deepEqual(buildOverview([], network, {}), []);
});
test("Peryn: its own daily and hourly hashrate give the 7-day trend and average miningpoolstats would", () => {
  // app.peryn.ai/api/pool/live on 2026-11-09 at 10:55 UTC, trimmed: days from 10-27 (today so far), the last 25 hours.
  const t = Date.parse("2026-11-09T12:00:00Z") / 1000;
  setNow(t);
  const day = (d, e) => ({ day: `2026-${d}`, hashrate: e * 1e18, miners: 1, blocks: 0 });
  const history = [day("10-31", 0.02), day("11-01", 0.04), day("11-02", 0.07), day("11-03", 0.17), day("11-04", 0.52),
    day("11-05", 0.84), day("11-06", 1.21), day("11-07", 1.87), day("11-08", 2.56), day("11-09", 3.05)];
  const hourly = Array.from({ length: 25 }, (_, i) =>
    ({ hour: new Date((t - (25 - i) * 3600) * 1000).toISOString().replace(".000", ""), hashrate: (2.4 + i * 0.05) * 1e18, miners: 1, blocks: 0 }));
  const o = { ...perynLive(), history: [...history].reverse(), hourly };
  const h = perynHistory(o, t);
  // Half of today has passed: today ½, six full days, half of the eighth day back.
  near(h.averageHashrate7d, (3.05 * 0.5 + 2.56 + 1.87 + 1.21 + 0.84 + 0.52 + 0.17 + 0.07 * 0.5) / 7 * 1e18);
  // Days at noon until the hours begin (11-08 11:00), then the hours at half past; only the last 7 days.
  assert.deepEqual(h.history.slice(0, 6).map((p) => [new Date(p.ts * 1000).toISOString().slice(0, 13), p.hashrate / 1e18]),
    [["2026-11-02T12", 0.07], ["2026-11-03T12", 0.17], ["2026-11-04T12", 0.52], ["2026-11-05T12", 0.84], ["2026-11-06T12", 1.21], ["2026-11-07T12", 1.87]]);
  assert.equal(h.history.length, 6 + 25);
  assert.equal(h.history.at(-1).ts, t - 3600 + 1800);
  assert.ok(h.history.every((p, i) => i === 0 || p.ts > h.history[i - 1].ts));
  // Its row carries them; a miningpoolstats listing of it would take over.
  const [row] = buildOverview([], { hashrate: 82e18, reward: 2200, prlPerTHDay: 0.02 }, { peryn: o });
  assert.deepEqual([row.history, row.averageHashrate7d], [h.history, h.averageHashrate7d]);
  // A pool two days old averages what it has; no days, no hours, or junk: nothing.
  near(perynHistory({ history: [day("11-08", 2), day("11-09", 4)] }, t).averageHashrate7d, (2 + 4 * 0.5) / 1.5 * 1e18);
  assert.equal(perynHistory({ history: [day("11-09", 4)] }, t).averageHashrate7d, null);
  for (const bad of [null, {}, { history: "x", hourly: [{ hour: "x", hashrate: 1 }, { hour: "2026-11-09T11:00:00Z", hashrate: -1 }] }])
    assert.deepEqual(perynHistory(bad, t), { history: [], averageHashrate7d: null });
  // A history that stopped over a day ago has no average; its old days still draw.
  assert.deepEqual(perynHistory({ history: [day("11-01", 1), day("11-02", 1)] }, t),
    { history: [{ ts: Date.parse("2026-11-02T12:00:00Z") / 1000, hashrate: 1e18 }, { ts: Date.parse("2026-11-01T12:00:00Z") / 1000, hashrate: 1e18 }].reverse(), averageHashrate7d: null });
  assert.deepEqual(buildOverview([], { hashrate: 82e18, reward: 2200 }, { peryn: perynLive() })[0].history, []);
  assert.equal(buildOverview([], { hashrate: 82e18, reward: 2200 }, { peryn: perynLive() })[0].averageHashrate7d, null);
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
    if (url.includes("miningpoolstats.stream/data/pearl.js"))
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
    if (url === "https://pearl.luckypool.io/api/stats")
      return Response.json({ config: { paymentMode: "prop", fee: 1 }, pool: { blocks: [] } });
    if (url === "https://pearlfortune.org/api/v1/stats/pool-fee-rate")
      return Response.json({ data: { chain: "pearl", pool_fee_rate: 0.02, pps_fee_rate: 0.035 } });
    if (url === "https://app.peryn.ai/api/pool/live") return Response.json(perynLive());
    if (url === "https://peryn.ai/api/live") return Response.json({ launch: { mining: "live", foundingRegistration: "open" } });
    if (url === "https://api.prlscan.com/v1/pools") return Response.json(prlscanReply([{ website_url: "https://pool.kryptex.com/prl", blocks_24h: 203 }]));
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
  // Twelve reads for the table (Pearl Fortune's summary and its fee rate, Lucky Pool's config, Peryn's pool and its
  // launch state, prlscan's block counts), then the newest blocks of each pool whose luck is taken out of Real Cost and our node's block
  // list (orphans). The explorer's orphans and HeroMiners' and Lucky Pool's blocks come from the table's own
  // reads, not a second fetch.
  assert.equal(urls.length, 14);
  assert.ok(urls.slice(0, 12).includes("https://pearlfortune.org/api/v1/stats/pool-fee-rate"));
  assert.ok(urls.slice(0, 12).includes("https://app.peryn.ai/api/pool/live"));
  assert.ok(urls.slice(0, 12).includes("https://peryn.ai/api/live"));
  assert.ok(urls.slice(0, 12).includes("https://api.prlscan.com/v1/pools"));
  assert.equal(urls.filter((u) => u === "https://pearl.luckypool.io/api/stats").length, 1);
  assert.deepEqual(urls.slice(12).sort(), ["https://node.pearlhub.net/chain/blocks.json", "https://pearlfortune.org/api/v1/blocks?page=1"]);
  assert.equal(r.body.rows.find((row) => row.name === "Lucky Pool").scheme, "PROP");
  const peryn = r.body.rows.find((row) => row.name === "Peryn");
  assert.deepEqual([peryn.fee, peryn.miners, peryn.payouts.map((p) => [p.scheme, p.founding?.fee])], [1, 35, [["PPS+", 0.5], ["PPLNS", 0]]]);
  const pplns = r.body.rows.find((row) => row.scheme === "PPLNS" && row.earningsPerPH != null && row.fee != null);
  assert.ok(pplns);
  assert.equal(pplns.payouts[0].realFeePercent, null); // A 24h snapshot cannot supply a five-day PPLNS estimate.
  assert.equal(pplns.payouts[0].realFeeEstimated, null);
  assert.equal(pplns.payouts[0].realFeePeriod, null);
  assert.equal(env.DB.rows("SELECT * FROM groups").length, 0);
  assert.ok(env.DB.rows("SELECT * FROM kv WHERE k LIKE 'pb:%'").length >= 4);
});
test("overview API: the luck bookkeeping is handed to waitUntil, not awaited by the reply", async () => {
  setNow(T0);
  const env = makeEnv();
  mock(env);
  const tasks = [];
  const res = await worker.fetch(new Request("https://prl.test/v1/pools"), env, { waitUntil: (t) => tasks.push(t) });
  assert.equal(res.status, 200);
  assert.ok(tasks.length >= 1);
  await Promise.all(tasks);
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

// Pearl Fortune's summary fails `failures` times, then answers; every other feed answers as in mock().
const flakyFortune = (env, failures) => {
  const urls = mock(env), base = globalThis.fetch, warnings = [], warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://pearlfortune.org/api/v1/summary") return base(url, init);
    urls.push(String(url));
    return ++calls <= failures ? new Response("down", { status: 503 })
      : Response.json({ data: { pool_stats: { pool_fee_rate: 0.02, rolling_stats: [] } } });
  };
  return { urls, warnings, restore: () => { console.warn = warn; } };
};
test("overview feeds: a pool's own API that fails once is read again a second later and the snapshot stays whole", async () => {
  setNow(T0);
  const env = makeEnv(), f = flakyFortune(env, 1);
  try {
    const r = await call(env, "GET", "/v1/pools");
    assert.equal(r.status, 200);
    assert.equal(r.body.partial, false);
    assert.equal(r.body.rows.find((row) => row.name === "Pearl Fortune").feeFromPoolAPI, true);
    assert.equal(f.urls.filter((u) => u === "https://pearlfortune.org/api/v1/summary").length, 2);
    assert.deepEqual(f.warnings, ["overview feed failed: Pearl Fortune, attempt 1, HTTP 503"]);
    // Through the whole reply (real fees and luck attached): PF's PPS fee from its fee-rate API, F2Pool's NOCK label.
    assert.deepEqual(r.body.rows.find((row) => row.name === "Pearl Fortune").payouts.map((p) => [p.scheme, p.fee]), [["PPS", 3.5], ["PPLNS", 2]]);
    assert.deepEqual(r.body.rows.find((row) => row.name === "F2Pool").payouts.map((p) => p.mergeBonus), [{ coin: "NOCK", minPercent: 1, maxPercent: 2 }]);
  } finally { f.restore(); }
});
test("overview feeds: Pearl Fortune's fee rate failing alone keeps the snapshot whole with the fallback PPS fee", async () => {
  setNow(T0);
  const env = makeEnv(), f = flakyFortune(env, 0), base = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url) === "https://pearlfortune.org/api/v1/stats/pool-fee-rate"
    ? new Response("down", { status: 502 }) : base(url, init);
  try {
    const r = await call(env, "GET", "/v1/pools");
    assert.equal(r.status, 200);
    assert.equal(r.body.partial, false);
    const pf = r.body.rows.find((row) => row.name === "Pearl Fortune");
    assert.equal(pf.feeFromPoolAPI, true);
    assert.deepEqual(pf.payouts.map((p) => [p.scheme, p.fee]), [["PPS", 4], ["PPLNS", 2]]);
    assert.deepEqual(f.warnings, ["overview feed failed: Pearl Fortune fee rate, HTTP 502"]);
  } finally { f.restore(); }
});
test("overview feeds: a second failure leaves the snapshot partial; the pool table's own feeds are not retried", async () => {
  setNow(T0);
  const env = makeEnv(), f = flakyFortune(env, 2);
  try {
    const r = await call(env, "GET", "/v1/pools");
    assert.equal(r.status, 200);
    assert.equal(r.body.partial, true);
    assert.equal(r.body.rows.find((row) => row.name === "Pearl Fortune").feeFromPoolAPI, false);
    assert.equal(f.urls.filter((u) => u === "https://pearlfortune.org/api/v1/summary").length, 2);
    assert.deepEqual(f.warnings, ["overview feed failed: Pearl Fortune, attempt 1, HTTP 503", "overview feed failed: Pearl Fortune, attempt 2, HTTP 503"]);
  } finally { f.restore(); }
  const env2 = makeEnv(), urls = mock(env2, { fallback: true }), warnings = [], warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    assert.equal((await call(env2, "GET", "/v1/pools")).body.partial, true);
    assert.equal(urls.filter((u) => u === "https://lordofpearls.xyz/pools").length, 1);
    assert.ok(warnings.includes("overview feed failed: lordofpearls pools, attempt 1, HTTP 503"), warnings.join(" | "));
    assert.ok(warnings.includes("overview feed failed: lordofpearls api, attempt 1, HTTP 503"), warnings.join(" | "));
  } finally { console.warn = warn; }
});
test("shared source: API callers reuse the durable snapshot and refresh after five minutes", async () => {
  setNow(T0);
  const env = makeEnv(), urls = mock(env);
  const first = await call(env, "GET", "/v1/pools");
  assert.equal(first.body.schemaVersion, 1);
  setNow(T0 + 200);
  const next = await call(env, "GET", "/v1/pools");
  assert.equal(next.body.ts, first.body.ts);
  assert.equal(urls.length, 14);
  setNow(T0 + 301);
  const refreshed = await call(env, "GET", "/v1/pools");
  assert.equal(refreshed.body.ts, T0 + 301);
  assert.equal(urls.length, 28);
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
