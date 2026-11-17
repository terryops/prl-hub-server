import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HERO, PEARLHASH, poissonInterval, rollingShareMeasurement, rollingPearlHashMeasurement, validRollingShareMeasurement } from "../src/shareyield.js";
import { mergeEfforts, recordPPLNSSnapshot, readPoolLuck, EFFORT_SOURCES, NODE_BLOCKS } from "../src/pplns.js";
import { attachRealFees } from "../src/realfees.js";
import { makeEnv, setNow, restoreNow, call } from "./helpers.js";

const fixture = JSON.parse(readFileSync(new URL("../../Tests/Fixtures/herominers_rounds_2026-11-09.json", import.meta.url)));
const DAY = 86400, at = fixture.at, end = Math.floor(at / DAY) * DAY;
const near = (a, b, error = 1e-9) => assert.ok(Math.abs(a - b) < error, `${a} != ${b}`);
afterEach(restoreNow);
const row = (changes = {}) => ({ id: HERO, name: "HeroMiners", solo: false, hashrate: 4e18, lifetimeBlocks: 6000,
  payouts: [{ scheme: "PROP", fee: 0, grossPerPH: 12, solo: false }], ...changes });

test("count intervals match independent Poisson inversion, including zero and large counts", () => {
  near(poissonInterval(0)[0], 0); near(poissonInterval(0)[1], 3.6888794541139363);
  near(poissonInterval(1)[0], .025317807984289876); near(poissonInterval(1)[1], 5.571643390938898);
  const expected = fixture.expected;
  const interval = poissonInterval(656);
  near(interval[0] / expected.sumRoundEffort, expected.foundBlockYieldCount95Diagnostic[0]);
  near(interval[1] / expected.sumRoundEffort, expected.foundBlockYieldCount95Diagnostic[1]);
  for (const bad of [-1, .5, 10001, NaN]) assert.throws(() => poissonInterval(bad));
});

test("real 27-day history reproduces the independent audit, without fixing either .955 or 1", () => {
  const result = rollingShareMeasurement(fixture.effort, 0, at), expected = fixture.expected;
  assert.ok(result); assert.equal(validRollingShareMeasurement(result, at), true);
  assert.equal((result.end - result.start) / DAY, 27);
  assert.deepEqual([result.poolBlocks, result.orphans, result.blocksSample], [656, 4, 652]);
  near(result.work, expected.sumRoundEffort);
  near(result.foundYield, expected.foundBlockYield);
  near(result.ratio, expected.canonicalBlockYield);
  near(result.cost95[0], (1 - expected.canonicalBlockYieldCount95Diagnostic[1]) * 100);
  near(result.cost95[1], (1 - expected.canonicalBlockYieldCount95Diagnostic[0]) * 100);
  assert.ok(result.foundYield95[0] < .955 && result.foundYield95[1] > 1);
});

test("current tariff and orphan losses are applied once over the same rolling window", () => {
  const base = rollingShareMeasurement(fixture.effort, 0, at);
  const paid = rollingShareMeasurement(fixture.effort, 2, at);
  near(paid.ratio, .98 * 652 / base.work);
  near(paid.ratio, .98 * base.foundYield * (1 - 4 / 656));
  assert.equal(paid.start, base.start); assert.equal(paid.end, base.end);
  const fullFee = rollingShareMeasurement(fixture.effort, 100, at);
  assert.equal(fullFee.ratio, 0); assert.deepEqual(fullFee.cost95, [100, 100]);
});

test("missing coverage, stale reads and malformed observations are withheld instead of becoming zero cost", () => {
  for (const change of [ { observedAt: at - 1801 }, { observedAt: at + 61 }, { observedAt: undefined }, { sourceVersion: 1 },
    { since: end - 4 * DAY }, { blocks: fixture.effort.blocks.slice(-20) },
    { blocks: [[1, end - DAY, -1, 0]] } ]) {
    assert.equal(rollingShareMeasurement({ ...fixture.effort, ...change }, 0, at), null);
  }
  const good = rollingShareMeasurement(fixture.effort, 0, at);
  for (const change of [{ end: end - DAY }, { sourceVersion: 1 }, { ratio: NaN }, { cost95: [10, 1] }, { foundYield95: [1, 1] }, { feePercent: 101 }])
    assert.equal(validRollingShareMeasurement({ ...good, ...change }, at), false);
});

test("the window caps at 30 complete UTC days, excludes today's blocks and preserves favorable output", () => {
  const blocks = Array.from({ length: 800 }, (_, i) => [i + 1, end - 40 * DAY + i * DAY / 20, .9, 0]);
  blocks.push([801, end + 100, 1000, 1]);
  const result = rollingShareMeasurement({ since: end - 40 * DAY, observedAt: at, sourceVersion: 2, blocks }, 0, at);
  assert.equal(result.start, end - 30 * DAY); assert.equal(result.end, end);
  assert.equal(result.poolBlocks, 600); assert.equal(result.orphans, 0);
  near(result.ratio, 1 / .9); assert.ok(result.cost95[0] < 0);
});

test("HeroMiners retains 35 days; other pools keep their existing eight-day effort limit", () => {
  const list = fixture.effort.blocks;
  const regular = mergeEfforts(null, list, at);
  const hero = mergeEfforts(null, list, at, false, EFFORT_SOURCES[HERO].keep);
  assert.ok(regular.since >= at - 8 * DAY);
  assert.equal(hero.blocks.length, list.length);
  assert.ok(hero.since < at - 27 * DAY);
});

test("a fresh block source persists a rolling summary, which reaches the public payout once", async () => {
  setNow(at);
  const env = makeEnv();
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind(`public:effort:${HERO}`, JSON.stringify(fixture.effort), at).run();
  await recordPPLNSSnapshot(env.DB, { ts: at, network: { prlPerTHDay: .01, reward: 2200 }, rows: [row()] });
  const read = await readPoolLuck(env.DB, at);
  assert.equal(read.pplns.length, 1); assert.equal(read.pplns[0].theoryBasis, "accepted_share_rounds");
  const first = attachRealFees({ rows: [row()] }, [], read.pplns).rows[0];
  const payout = first.payouts[0];
  near(payout.realFeePercent, 4.327139899798249);
  assert.equal(payout.shareYield, undefined);
  assert.equal(payout.realFeeEstimate.poolBlocks, 656);
  near(attachRealFees({ rows: [first] }, [], read.pplns).rows[0].payouts[0].realFeePercent, payout.realFeePercent);
  const stale = await readPoolLuck(env.DB, at + 1801);
  assert.equal(stale.pplns.length, 0);
  const withheld = attachRealFees({ rows: [first] }, [], stale.pplns).rows[0].payouts[0];
  assert.equal(withheld.realFeePercent, null); assert.equal(withheld.realFeeEstimate, undefined);
});

test("HeroMiners backfill continues beyond seven days and preserves older round records", async () => {
  setNow(at);
  const env = makeEnv(), all = fixture.effort.blocks;
  const existing = all.filter((b) => b[1] >= at - 9 * DAY);
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind(`public:effort:${HERO}`, JSON.stringify({ since: existing[0][1], sourceVersion: 2, blocks: existing }), at).run();
  const oldPage = all.filter((b) => b[0] < existing[0][0]).slice(-10), asked = [];
  const encode = (list) => list.flatMap(([h, ts, effort, orphan]) =>
    [`hash:${ts}:1000:${effort * 1000}:0:hash:${orphan ? "orphaned" : "unlocked"}:1:address:region:prop`, h]);
  await recordPPLNSSnapshot(env.DB, { ts: at, network: { prlPerTHDay: .01, reward: 2200 }, rows: [row()] }, async (url) => {
    if (url.includes("lordofpearls") || url === NODE_BLOCKS) return {};
    asked.push(url);
    return url.includes("get_blocks") ? encode(oldPage) : { pool: { blocks: encode(existing.slice(-10)) } };
  });
  assert.ok(asked.some((url) => url.includes("get_blocks?height=")));
  const saved = JSON.parse(env.DB.one(`SELECT v FROM kv WHERE k='public:effort:${HERO}'`).v);
  assert.ok(saved.since < existing[0][1]); assert.equal(saved.observedAt, at);
  assert.ok(saved.blocks.some((b) => b[1] < at - 8 * DAY));
});

test("the public endpoint withholds the new cost from legacy clients and exposes it to capable clients", async () => {
  setNow(at);
  const env = makeEnv(), snapshot = { ok: true, schemaVersion: 1, ts: at, network: { ts: at, prlPerTHDay: .01, reward: 2200 }, rows: [row()] };
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind(`public:effort:${HERO}`, JSON.stringify(fixture.effort), at).run();
  await recordPPLNSSnapshot(env.DB, snapshot);
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind("public:overview:v1", JSON.stringify(snapshot), at).run();
  for (const path of ["/v1/pools", "/v1/pools?real_cost=unknown"]) {
    const result = await call(env, "GET", path);
    assert.equal(result.status, 200);
    assert.equal(result.body.rows[0].payouts[0].realFeePercent, null);
    assert.equal(result.body.rows[0].payouts[0].realFeeEstimate, undefined);
  }
  const current = await call(env, "GET", "/v1/pools?real_cost=rolling");
  assert.equal(current.status, 200);
  near(current.body.rows[0].payouts[0].realFeePercent, 4.327139899798249);
  assert.equal(current.body.rows[0].payouts[0].realFeeEstimate.poolBlocks, 656);
});

test("a pre-correction HeroMiners cache is rebuilt before it can publish mixed SOLO work", async () => {
  setNow(at);
  const env = makeEnv(), old = { ...fixture.effort };
  delete old.sourceVersion;
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind(`public:effort:${HERO}`, JSON.stringify(old), at).run();
  const recent = fixture.effort.blocks.slice(-10);
  const blocks = recent.flatMap(([h, ts, effort, orphan]) =>
    [`hash:${ts}:1000:${effort * 1000}:0:hash:${orphan ? "orphaned" : "unlocked"}:1:address:region:prop`, h]);
  await recordPPLNSSnapshot(env.DB, { ts: at, network: { prlPerTHDay: .01, reward: 2200 }, rows: [row()] }, async (url) =>
    url.endsWith("/api/stats") ? { pool: { blocks } } : {});
  const saved = JSON.parse(env.DB.one(`SELECT v FROM kv WHERE k='public:effort:${HERO}'`).v);
  assert.equal(saved.sourceVersion, 2);
  assert.equal(saved.blocks.length, 10);
  assert.equal((await readPoolLuck(env.DB, at)).pplns.length, 0);
});

test("PearlHash rolling accepted-share estimate ignores its display multiplier, stops at incomplete days and carries 95% CI", async () => {
  const days = [
    // Incomplete start day (<90% observed): stops the contiguous backward walk, never tilted in.
    [end - 8 * DAY, 50960, 69, 68.95, 63.09],
    // Complete days across both display regimes (0.915 then 0.9821): display column d[4] is ignored.
    [end - 7 * DAY, 86400, 86, 102.62, 93.90],
    [end - 6 * DAY, 86175, 84, 100.12, 91.61],
    [end - 5 * DAY, 86485, 84, 92.96, 87.77],
    [end - 4 * DAY, 86493, 88, 85.93, 1],
    [end - 3 * DAY, 86524, 75, 84.77, 999],
    [end - 2 * DAY, 86055, 77, 82.13, 80.66],
    [end - DAY, 86573, 83, 83.30, 81.81],
    // Partial current UTC day: excluded.
    [end, 10691, 9, 10.18, 10.00],
  ];
  const record = { last: { ts: at, blocks: 22000, diffRate: 60000, display: 1.6e19, difficulty: 6e7 }, days };
  const r = rollingPearlHashMeasurement(record, 1, at);
  assert.ok(r); assert.equal(validRollingShareMeasurement(r, at), true);
  assert.equal(r.id, PEARLHASH); assert.equal(r.pool, "PearlHash"); assert.equal(r.theoryBasis, "accepted_share_work");
  assert.equal(r.start, end - 7 * DAY); assert.equal(r.end, end);
  const wantBlocks = 86 + 84 + 84 + 88 + 75 + 77 + 83;
  const wantWork = 102.62 + 100.12 + 92.96 + 85.93 + 84.77 + 82.13 + 83.30;
  assert.equal(r.poolBlocks, wantBlocks); assert.equal(r.blocksSample, wantBlocks); assert.equal(r.orphans, 0);
  near(r.work, wantWork); near(r.ratio, .99 * wantBlocks / wantWork);
  assert.ok(r.cost95[0] < (1 - r.ratio) * 100 && r.cost95[1] > (1 - r.ratio) * 100);
  // Large 30-day block counts (>3000) work cleanly; legacy /v1/pools withholds it while rolling-capable clients get it.
  const thirty = Array.from({ length: 30 }, (_, i) => [end - (30 - i) * DAY, 86400, 120, 122, 120]);
  const big = rollingPearlHashMeasurement({ ...record, days: thirty }, 1, at);
  assert.equal(big.poolBlocks, 3600); assert.equal(validRollingShareMeasurement(big, at), true);
  assert.equal(validRollingShareMeasurement({ ...big, orphans: 1, blocksSample: 3599 }, at), false);

  setNow(at);
  const env = makeEnv();
  const phRow = { id: PEARLHASH, name: "PearlHash", solo: false, hashrate: 1.6e19, lifetimeBlocks: 22000,
    payouts: [{ scheme: "PROP", fee: 1, grossPerPH: 11, solo: false }] };
  const snapshot = { ok: true, schemaVersion: 1, ts: at, network: { ts: at, prlPerTHDay: .01, reward: 2200, difficulty: 6e7 }, rows: [phRow] };
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind("public:pearlhash-work:v1", JSON.stringify(record), at).run();
  await recordPPLNSSnapshot(env.DB, snapshot);
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind("public:overview:v1", JSON.stringify(snapshot), at).run();
  assert.equal((await call(env, "GET", "/v1/pools")).body.rows[0].payouts[0].realFeePercent, null);
  const live = (await call(env, "GET", "/v1/pools?real_cost=rolling")).body.rows[0].payouts[0];
  near(live.realFeePercent, (1 - r.ratio) * 100);
  assert.equal(live.realFeeEstimate.theoryBasis, "accepted_share_work");
  assert.equal(live.shareYield, undefined);
});

test("PearlHash factor-change history exposes displayFactor, prior and since segments without altering the 30-day figure", () => {
  const days = [];
  for (let i = 27; i >= 15; i--) days.push([end - i * DAY, 86400, 99, 109.28, 109.28 * 0.915]);
  days.push([end - 14 * DAY, 86400, 84, 92.97, 92.97 * 0.9442]);
  for (let i = 13; i >= 1; i--) days.push([end - i * DAY, 86400, 81, 79.7, 79.7 * 0.9821]);
  const record = { last: { ts: at, blocks: 22358, diffRate: 50000, display: 1.4e19, difficulty: 6e7 }, days };
  const r = rollingPearlHashMeasurement(record, 1, at);
  assert.ok(r); assert.equal(validRollingShareMeasurement(r, at), true);
  assert.ok(r.displayFactor && r.prior && r.since);
  near(r.displayFactor.factor, 0.9821, 1e-6);
  near(r.displayFactor.percent, (1 - 0.99 * 0.9821) * 100, 1e-4);
  assert.equal(r.displayFactor.since, end - 13 * DAY);
  assert.equal(r.prior.start, end - 27 * DAY); assert.equal(r.prior.end, end - 14 * DAY);
  assert.equal(r.since.start, end - 14 * DAY); assert.equal(r.since.end, end);
  assert.equal(r.prior.poolBlocks + r.since.poolBlocks, r.poolBlocks);
  near(r.prior.work + r.since.work, r.work, 1e-6);
  assert.equal(validRollingShareMeasurement({ ...r, displayFactor: { ...r.displayFactor, factor: 1.2 } }, at), false);
  assert.equal(validRollingShareMeasurement({ ...r, prior: { ...r.prior, end: r.since.start - DAY } }, at), false);
});
