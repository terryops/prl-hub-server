import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HERO, poissonInterval, rollingShareMeasurement, validRollingShareMeasurement } from "../src/shareyield.js";
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
  for (const bad of [-1, .5, 3001, NaN]) assert.throws(() => poissonInterval(bad));
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
