import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pplnsPoint, extendPPLNSHistory, pplnsMeasurement, validPPLNSMeasurement, recordPPLNSSnapshot, readPoolLuck, luckWindows, sharedPayout, costEstimated, mergeEfforts, EFFORT_SOURCES, extendPearlHashWork, orphanWindow, validOrphans, attachLuck, extendChainOrphans, chainOrphanWindow, counterSeed } from "../src/pplns.js";
import { makeEnv, setNow, restoreNow, T0, call, installFetch, tick } from "./helpers.js";

afterEach(restoreNow);
const DAY = 86400;
const near = (a, b, e = 1e-8) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const point = (ts, changes = {}) => ({ ts, hashPH: 1, unit: 100, reward: 1, fee: 2, blocks: 1000 + Math.floor((ts - T0) / 1080), ...changes });
const historyTo = (end, changes = {}) => {
  let value;
  for (let ts = T0; ts <= end; ts += 300) value = extendPPLNSHistory(value, "alpha", "AlphaPool", point(ts, changes));
  return value;
};
const history = (days, changes = {}) => historyTo(T0 + days * DAY, changes);
/// The pool's own block list for a history: a block wherever the chain counter steps (every
/// 1,080 s, 80 a day, where the displayed work expects 100), each taking `effort` blocks of work.
/// With `orphans`, an extra block that lost the race follows each one, ten minutes later.
const effortFor = (end, { effort = 1.25, since = T0, orphans = false, every = 1 } = {}) => {
  const blocks = [];
  for (let k = 1; T0 + k * 1080 <= end; k++) {
    if (T0 + k * 1080 < since || k % every) continue;
    blocks.push([10 * k, T0 + k * 1080, effort, 0]);
    if (orphans) blocks.push([10 * k + 5, T0 + k * 1080 + 600, effort, 1]);
  }
  return { since, blocks };
};
const measure = (h, t, options) => pplnsMeasurement(h, t, effortFor(h.last.ts, options));
const LUCKY = "https://pearl.luckypool.io/";
const row = { id: "alpha", name: "AlphaPool", solo: false, hashrate: 1e15, lifetimeBlocks: 1000,
  payouts: [{ scheme: "PPLNS", solo: false, fee: 2, grossPerPH: 80, realFeePercent: null }] };
const snapshot = (ts = T0, changes = {}) => ({ ok: true, schemaVersion: 1, ts, stale: false, partial: false,
  rows: [row], network: { ts, prlPerTHDay: .1, reward: 1 }, ...changes });

test("PPLNS: a complete five-day window is required; pool work and rewards are aggregated, not percentages", () => {
  const h = history(5), end = T0 + 5 * DAY, value = measure(h, end);
  assert.equal(measure(history(4), T0 + 4 * DAY), null);
  assert.equal(measure(history(5 - 300 / DAY), end), null);
  assert.equal(value.start, T0); assert.equal(value.end, end);
  near(value.expectedPRL, 500); near(value.netPRL, 392);
  near((1 - value.netPRL / value.expectedPRL) * 100, 21.6); // fee and luck together
  assert.equal(value.sampleCount, 1440); assert.equal(value.blocksSample, 400);
  assert.equal(value.poolBlocks, 400); near(value.work, 500); near(value.luck, .8);
  assert.ok(h.segments.length <= 121); // Bounded hourly buckets rather than thousands of stored samples.
});

test("PPLNS: a cost estimate needs the window's work to be worth 100 blocks", () => {
  // 15 blocks' worth a day: five days is 75 blocks, too few; a full week's 105 is enough.
  const small = { hashPH: .15 };
  assert.equal(measure(history(5, small), T0 + 5 * DAY), null);
  assert.equal(measure(history(6, small), T0 + 6 * DAY), null);
  const week = measure(history(7, small), T0 + 7 * DAY);
  near(week.expectedBlocks, 105, 1e-6);
  assert.ok(validPPLNSMeasurement(week, T0 + 7 * DAY));
  // Expected blocks follow the block reward: a doubled reward halves them.
  near(measure(history(5), T0 + 5 * DAY).expectedBlocks, 500, 1e-6);
  near(measure(history(5, { reward: 2 }), T0 + 5 * DAY).expectedBlocks, 250, 1e-6);
  assert.equal(measure(history(5, { reward: 5.01 }), T0 + 5 * DAY), null);
  // A summary written before the threshold carries no block count and is not shown.
  const { expectedBlocks, ...old } = week;
  assert.equal(validPPLNSMeasurement(old, T0 + 7 * DAY), false);
  assert.equal(validPPLNSMeasurement({ ...week, expectedBlocks: 99.99 }, T0 + 7 * DAY), false);
});

test("PPLNS: trapezoidal work and reward/fee changes use their observation intervals", () => {
  const first = point(T0, { blocks: 10, fee: 0 }), last = point(T0 + 600, { hashPH: 3, unit: 200, reward: 3, blocks: 12, fee: 10 });
  const h = extendPPLNSHistory(extendPPLNSHistory(null, "alpha", "AlphaPool", first), "alpha", "AlphaPool", last);
  near(h.segments[0].expectedPRL, 350 * 600 / DAY);
  near(h.segments[0].netPRL, 3.8);
  assert.equal(h.segments[0].blocks, 2);
  const same = extendPPLNSHistory(h, "alpha", "AlphaPool", last);
  assert.equal(same, h);
  assert.equal(extendPPLNSHistory(h, "alpha", "AlphaPool", first), h);
});

test("PPLNS: gaps and counter changes leave a hole instead of restarting; corrupt histories cannot establish coverage", () => {
  const h = history(5), end = h.last.ts, before = measure(h, end);
  // A long gap, a counter that went back and an implausible jump each drop only their interval.
  for (const p of [point(end + 1801), point(end + 300, { blocks: 0 }), point(end + 300, { blocks: h.last.blocks + 6 })]) {
    const next = extendPPLNSHistory(h, "alpha", "AlphaPool", p);
    assert.deepEqual(next.segments, h.segments.filter((s) => s.end > p.ts - 7 * DAY));
    assert.equal(next.last.ts, p.ts);
    const value = pplnsMeasurement(next, p.ts, effortFor(end));
    near(value.netPRL, before.netPRL); near(value.expectedPRL, before.expectedPRL); near(value.ratio, before.ratio);
    assert.equal(value.end, p.ts); assert.equal(value.covered, 5 * DAY);
    // Counting resumes from the new point, in a segment of its own.
    const resumed = extendPPLNSHistory(next, "alpha", "AlphaPool", { ...p, ts: p.ts + 300, blocks: p.blocks + 1 });
    assert.deepEqual(resumed.segments.at(-1), { start: p.ts, end: p.ts + 300, netPRL: .98, grossPRL: 1,
      expectedPRL: 100 * 300 / DAY, work: 300 / DAY, blocks: 1, samples: 1 });
  }
  // Up to 30 minutes is still one observed interval.
  assert.equal(extendPPLNSHistory(h, "alpha", "AlphaPool", point(end + 1800)).segments.at(-1).end, end + 1800);
  const overlap = structuredClone(h); overlap.segments[2].start--;
  assert.equal(measure(overlap, end), null);
  const negative = structuredClone(h); negative.segments[0].netPRL = -1;
  assert.equal(measure(negative, end), null);
  assert.equal(measure(h, end + 1801), null);
  assert.equal(measure(h, end - 61), null);
});

test("PPLNS: five days of observed time are required; holes extend the span up to seven days", () => {
  // Four days, a two-hour outage, then more: no value until observed time reaches five days.
  let h = history(4);
  const resume = h.last.ts + 2 * 3600;
  for (let ts = resume; ts <= T0 + 5 * DAY + 2 * 3600; ts += 300) h = extendPPLNSHistory(h, "alpha", "AlphaPool", point(ts));
  assert.equal(measure(h, T0 + 5 * DAY + 3600), null);
  const value = measure(h, h.last.ts);
  assert.equal(value.covered, 5 * DAY); assert.equal(value.end - value.start, 5 * DAY + 2 * 3600);
  // Blocks the pool found during the outage are left out with the chain's: still bad luck only.
  assert.equal(value.poolBlocks, value.blocksSample); near(value.ratio, .98, 1e-3);
  // More than two days of holes in the last seven leaves too little to show.
  let sparse = history(3);
  for (let ts = sparse.last.ts + 2.5 * DAY; ts <= T0 + 7 * DAY; ts += 300) sparse = extendPPLNSHistory(sparse, "alpha", "AlphaPool", point(ts));
  assert.equal(measure(sparse, sparse.last.ts), null);
});

test("PPLNS: luck is taken out — bad luck costs nothing, lost work and orphans do, a low display is capped", () => {
  const end = T0 + 5 * DAY, h = history(5); // 80 blocks a day on chain where the display expects 100, 2% fee
  const cost = (options, hist = h) => (1 - measure(hist, end, options).ratio) * 100;
  // The pool's own shares took 1.25 blocks of work a block: the shortfall is luck, only the fee remains.
  near(cost({ effort: 1.25 }), 2);
  // Its shares say luck was even: the work its display showed never became shares. That is kept.
  near(cost({ effort: 1 }), 21.6);
  // Shares worth 1.5 blocks each, above the displayed work: the display runs low and the shares
  // are the baseline. Without that, this pool would show −17.6%.
  near(cost({ effort: 1.5 }), 2);
  // Good luck is taken out the same way: twice the expected blocks at 0.5 blocks of work each.
  const lucky = history(5, { reward: 2, fee: 0 });
  near((1 - measure(lucky, end, { effort: 2 }).netPRL / measure(lucky, end, { effort: 2 }).expectedPRL) * 100, -60);
  near(cost({ effort: 2 }, lucky), 0);
  near(cost({ effort: 1.6 }, lucky), 0);
  // Orphans: blocks the pool found and lost. Their work counts, their reward never came.
  const orphaned = measure(h, end, { effort: 1.25, orphans: true });
  // (The last orphan would come after the window.) Half its blocks lost: about half its output.
  assert.equal(orphaned.poolBlocks, 799); assert.equal(orphaned.orphans, 399); assert.equal(orphaned.blocksSample, 400);
  near((1 - orphaned.ratio) * 100, (1 - .784 * 500 / 799) * 100);
  // No pool list, a list that starts late, or one that disagrees with the chain: no estimate.
  assert.equal(pplnsMeasurement(h, end), null);
  assert.equal(pplnsMeasurement(h, end, { since: T0, blocks: [] }), null);
  assert.equal(measure(h, end, { since: T0 + DAY }), null);
  assert.equal(measure(h, end, { every: 2 }), null);
  assert.equal(pplnsMeasurement(h, end, { since: T0, blocks: [[1, T0 + 1, 1, 0], [1, T0 + 2, 1, 0]] }), null);
  // A list that starts a little late still covers five days of a longer history.
  const week = history(7), later = measure(week, T0 + 7 * DAY, { since: T0 + DAY + 1 });
  assert.ok(later.start >= T0 + DAY + 1 && later.covered >= 5 * DAY); near((1 - later.ratio) * 100, 2);
  // A pool that found nothing has no blocks to measure its luck by.
  assert.equal(measure(history(5, { blocks: 1000 }), end), null);
  assert.equal(measure(history(5, { hashPH: 0 }), end), null);
  // A fortnight of history is kept for block luck; the cost estimate still spans one week.
  const kept = history(16), value = measure(kept, T0 + 16 * DAY);
  assert.ok(value.end - value.start >= 5 * DAY && value.end - value.start <= 7 * DAY + 3600);
  assert.ok(kept.segments.length <= 14 * 24 + 1);
  assert.ok(kept.segments[0].end > kept.last.ts - 14 * DAY && kept.segments[0].start >= kept.last.ts - 14 * DAY - 3600);
});

test("pool lists: the newest list joins on or starts again; older pages extend back; a week and a day is kept", () => {
  const b = (h, ts, e = 1, o = 0) => [h, ts, e, o];
  const first = mergeEfforts(null, [b(30, T0 + 300), b(10, T0 + 100), b(20, T0 + 200)], T0 + 300);
  assert.deepEqual(first, { since: T0 + 100, blocks: [b(10, T0 + 100), b(20, T0 + 200), b(30, T0 + 300)] });
  // Overlapping: new blocks join, and a block's later state (orphaned) replaces the old one.
  const joined = mergeEfforts(first, [b(30, T0 + 300, 1, 1), b(40, T0 + 400)], T0 + 400);
  assert.deepEqual(joined, { since: T0 + 100, blocks: [b(10, T0 + 100), b(20, T0 + 200), b(30, T0 + 300, 1, 1), b(40, T0 + 400)] });
  // Nothing in common with what is stored: blocks in between may be missing, so it starts again.
  assert.deepEqual(mergeEfforts(joined, [b(60, T0 + 600), b(70, T0 + 700)], T0 + 700), { since: T0 + 600, blocks: [b(60, T0 + 600), b(70, T0 + 700)] });
  // An older page: only blocks before the oldest stored one are added, and `since` moves back.
  const back = mergeEfforts(joined, [b(5, T0 + 50), b(8, T0 + 80), b(10, T0 + 100), b(99, T0 + 999)], T0 + 400, true);
  assert.equal(back.since, T0 + 50); assert.deepEqual(back.blocks.map((x) => x[0]), [5, 8, 10, 20, 30, 40]);
  assert.equal(mergeEfforts(joined, [b(20, T0 + 200)], T0 + 400, true), joined);
  assert.equal(mergeEfforts(null, [b(5, T0 + 50)], T0, true), null);
  // A list we could not read (null) or an empty one leaves the stored list as it is.
  assert.equal(mergeEfforts(joined, null, T0 + 400), joined);
  assert.equal(mergeEfforts(joined, [], T0 + 400), joined);
  // Re-dated blocks cannot run backwards; blocks older than eight days go and `since` follows.
  assert.deepEqual(mergeEfforts(null, [b(1, T0 + 500), b(2, T0 + 400)], T0 + 500).blocks.map((x) => x[1]), [T0 + 500, T0 + 500]);
  const old = mergeEfforts(joined, [b(40, T0 + 400), b(50, T0 + 8 * DAY + 250)], T0 + 8 * DAY + 250);
  assert.deepEqual(old.blocks.map((x) => x[0]), [30, 40, 50]); assert.equal(old.since, T0 + 300);
});

test("pool lists: before a short block list, the pool's own daily totals cover the week's whole days", () => {
  const end = T0 + 7 * DAY, h = history(7), all = effortFor(end);
  // The pool's daily totals, as its block-stats gives them: [day, blocks, blocks × effort, orphans].
  const days = (blocks) => [...Map.groupBy(blocks, (b) => Math.floor(b[1] / DAY) * DAY)].map(([d, bs]) =>
    [d, bs.length, bs.reduce((a, b) => a + b[2], 0), bs.reduce((a, b) => a + b[3], 0)]);
  const since = T0 + 4.25 * DAY, list = (extra = {}) => ({ since, blocks: all.blocks.filter((b) => b[1] >= since), days: days(all.blocks), ...extra });
  const full = pplnsMeasurement(h, end, all), joined = pplnsMeasurement(h, end, list());
  // The same week as the whole block list gives: bad luck only, the fee remains.
  assert.equal(joined.start, T0); near(joined.ratio, full.ratio, 1e-12); near((1 - joined.ratio) * 100, 2);
  assert.equal(joined.poolBlocks, full.poolBlocks); near(joined.work, full.work, 1e-9);
  // The block list alone is too short.
  assert.equal(pplnsMeasurement(h, end, list({ days: undefined })), null);
  // A missing day, a day the list starts on that is not over, or totals below what the list holds: no days.
  assert.equal(pplnsMeasurement(h, end, list({ days: days(all.blocks).filter((d) => d[0] !== T0 + 2 * DAY) })), null);
  const today = T0 + 6.9 * DAY;
  assert.equal(pplnsMeasurement(h, end, { since: today, blocks: all.blocks.filter((b) => b[1] >= today), days: days(all.blocks) }), null);
  assert.equal(pplnsMeasurement(h, end, list({ days: days(all.blocks).map((d) => d[0] === T0 + 4 * DAY ? [d[0], 10, 12.5, 0] : d) })), null);
  // Totals that disagree with the chain fail its check like a block list would.
  assert.equal(pplnsMeasurement(h, end, list({ days: days(all.blocks).map((d) => d[0] < T0 + 4 * DAY ? [d[0], d[1] + 10, d[2] + 12.5, 0] : d) })), null);
  // A two-hour hole in those days: daily totals count blocks we never saw, but luck is their mean
  // effort, so the result holds. Days we mostly did not see: the list is measured alone (too short).
  let holed = historyTo(T0 + 2 * DAY);
  for (let ts = holed.last.ts + 2 * 3600; ts <= end; ts += 300) holed = extendPPLNSHistory(holed, "alpha", "AlphaPool", point(ts));
  const withHole = pplnsMeasurement(holed, end, list());
  assert.equal(withHole.poolBlocks - withHole.blocksSample, 6); near(withHole.ratio, .98, 1e-12);
  let gone = historyTo(T0 + DAY);
  for (let ts = gone.last.ts + 12 * 3600; ts <= end; ts += 300) gone = extendPPLNSHistory(gone, "alpha", "AlphaPool", point(ts));
  assert.equal(pplnsMeasurement(gone, end, list()), null);
  // A list that already covers the week ignores the days.
  assert.deepEqual(pplnsMeasurement(h, end, { ...all, days: [[T0, 1, 99, 0]] }), full);
});

test("pool lists: each source reads its own format; a block it cannot read discards the list", () => {
  const parse = (id, o) => EFFORT_SOURCES[id].parse(o);
  // Pearl Fortune, 2026-10-20: created_at with its offset, effort, submit_status.
  const fortune = { data: { blocks: [
    { block_height: 130642, effort: 0.745947, submit_status: "accepted", created_at: "2026-10-20T15:40:25+08:00" },
    { block_height: 130628, effort: 1.662272, submit_status: "confirmed", created_at: "2026-10-20T15:08:23+08:00" },
    { block_height: 130600, effort: 2.1, submit_status: "orphaned", created_at: "2026-10-20T14:00:00+08:00" },
    { block_height: 130590, effort: 0.2, submit_status: "rejected", created_at: "2026-10-20T13:00:00+08:00" }] } };
  assert.deepEqual(parse("https://pearlfortune.org/", fortune), [[130642, 1792482025, 0.745947, 0],
    [130628, 1792480103, 1.662272, 0], [130600, 1792476000, 2.1, 1]]);
  assert.equal(parse("https://pearlfortune.org/", { data: { blocks: [{ ...fortune.data.blocks[0], effort: null }] } }), null);
  assert.equal(parse("https://pearlfortune.org/", { data: {} }), null);
  // Lucky Pool: hash:time:difficulty:shares:orphaned:reward:solo, then the height.
  const lucky = { pool: { blocks: [
    "0x46:1792483029:171447745753230980:26806814333337600:0:223933423463:0", "130651",
    "0xf0:1792482609:171341118807249100:246868926159585280:1:223935717656:0", "130647",
    "0xaa:1792482000:171341118807249100:171341118807249100:0:223935717656:1", "130640"] } };
  const l = parse(LUCKY, lucky);
  assert.deepEqual(l.map((x) => [x[0], x[1], x[3]]), [[130651, 1792483029, 0], [130647, 1792482609, 1]]);
  near(l[0][2], 26806814333337600 / 171447745753230980); near(l[1][2], 246868926159585280 / 171341118807249100);
  assert.equal(parse(LUCKY, { pool: { blocks: ["0x46:1792483029:0:5:0:1:0", "130651"] } }), null);
  assert.equal(parse(LUCKY, { pool: { blocks: ["0x46:1792483029:1:5:0:1:0"] } }), null);
  // HeroMiners: /api/stats and get_blocks share hash:time:difficulty:shares:score:hash:status:reward:address:region:scheme.
  const hero = ["d3:1792469299:2607960229071:3484127487590:3484006377062:d3:pending:224001991203:prl1p:na-ca:prop:", "130568",
    "64:1792373250:2541988767454:1590967350067:1590904592793:64:orphaned:224319402387:prl1p:eu-de:prop", "129995",
    "65:1792373000:2541988767454:1590967350067:1590904592793:65:unlocked:224319402387:prl1p:eu-de:solo", "129990"];
  const fromStats = parse("https://pearl.herominers.com/", { pool: { blocks: hero } });
  assert.deepEqual(fromStats, parse("https://pearl.herominers.com/", hero));
  assert.deepEqual(fromStats.map((x) => [x[0], x[3]]), [[130568, 0], [129995, 1]]);
  near(fromStats[0][2], 3484127487590 / 2607960229071);
  assert.equal(EFFORT_SOURCES["https://pearl.herominers.com/"].older({ blocks: [[129995, 1, 1, 0]] }),
    "https://pearl.herominers.com/api/get_blocks?height=129995");
  assert.equal(EFFORT_SOURCES["https://pearlfortune.org/"].older({ blocks: new Array(40) }), "https://pearlfortune.org/api/v1/blocks?page=3");
  // Jetski: recent_blocks_found with effort and lifecycle_status.
  const jetski = { recent_blocks_found: [
    { time: 1792482839, height: 130648, effort: 1.8887246077672546, status: "accepted", lifecycle_status: "confirmed" },
    { time: 1792470000, height: 130560, effort: 0.4, status: "accepted", lifecycle_status: "orphan" }] };
  assert.deepEqual(parse("https://pearl.jetskipool.ai/", jetski), [[130648, 1792482839, 1.8887246077672546, 0], [130560, 1792470000, 0.4, 1]]);
  assert.equal(parse("https://pearl.jetskipool.ai/", { recent_blocks_found: [{ ...jetski.recent_blocks_found[0], effort: null }] }), null);
  // Lucky Pool's daily totals: date is the day's last second; a day with solo blocks is left out.
  const stats = { avg7d: 1.04, data: [
    { date: 1792281599, effort: 0.9736, block: 31, solo: 0, orphan: 0, uncle: 0, label: "17-Oct" },
    { date: 1792367999, effort: 1.1596, block: 25, solo: 1, orphan: 0, uncle: 0, label: "18-Oct" },
    { date: 1792454399, effort: 1.0303, block: 28, solo: 0, orphan: 1, uncle: 0, label: "19-Oct" }] };
  const d = EFFORT_SOURCES[LUCKY].parseDays(stats);
  assert.deepEqual(d.map((x) => [x[0], x[1], x[3]]), [[1792195200, 31, 0], [1792368000, 28, 1]]);
  near(d[0][2], 31 * .9736); near(d[1][2], 28 * 1.0303);
  assert.equal(EFFORT_SOURCES[LUCKY].parseDays({ data: [{ ...stats.data[0], date: 1792281000 }] }), null);
  assert.equal(EFFORT_SOURCES[LUCKY].parseDays({ data: [{ ...stats.data[0], effort: null }] }), null);
  assert.equal(EFFORT_SOURCES[LUCKY].days, "https://pearl.luckypool.io/api/block-stats");
  // PearlHash publishes no per-block effort: no source, so no estimate.
  assert.equal(EFFORT_SOURCES["https://pearlhash.xyz/"], undefined);
});

test("PPLNS: missing hash, counters, fee or network work withholds a public sample; PPS and SOLO are excluded", () => {
  assert.deepEqual(pplnsPoint(snapshot(), row), point(T0));
  for (const changes of [{ hashrate: null }, { hashrate: NaN }, { hashrate: -1 }, { lifetimeBlocks: null },
    { lifetimeBlocks: -1 }, { lifetimeBlocks: 1.1 }, { solo: true },
    { payouts: [{ scheme: "PPS", fee: 2 }] }, { payouts: [{ scheme: "PPLNS", fee: null }] },
    { payouts: [{ scheme: "PPLNS", fee: 101 }] }]) assert.equal(pplnsPoint(snapshot(), { ...row, ...changes }), null);
  for (const changes of [{ stale: true }, { network: null }, { network: { prlPerTHDay: 0, reward: 1 } }])
    assert.equal(pplnsPoint(snapshot(T0, changes), row), null);
});

test("PPLNS: cached snapshots cannot extend coverage; reads stay address-free and a ready window reaches the API", async () => {
  const env = makeEnv(); setNow(T0);
  const pool = { ...row, id: LUCKY, name: "Lucky Pool" }, put = (k, v, ts) => env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(k, JSON.stringify(v), ts).run();
  await recordPPLNSSnapshot(env.DB, snapshot(T0, { rows: [pool] }));
  await recordPPLNSSnapshot(env.DB, snapshot(T0, { rows: [pool] }));
  assert.deepEqual((await readPoolLuck(env.DB)).pplns, []);
  // Five days less one sample are stored; the next recorded snapshot completes the window.
  const end = T0 + 5 * DAY; setNow(end);
  await put(`public:pplns:${LUCKY}`, { ...historyTo(end - 300), id: LUCKY, pool: "Lucky Pool" }, end);
  const saved = snapshot(end, { rows: [{ ...pool, lifetimeBlocks: point(end).blocks }] });
  // Without the pool's own block list there is no estimate: it would be fee and luck together.
  await recordPPLNSSnapshot(env.DB, saved);
  assert.deepEqual((await readPoolLuck(env.DB)).pplns, []);
  await put(`public:pplns:${LUCKY}`, { ...historyTo(end - 300), id: LUCKY, pool: "Lucky Pool" }, end);
  await put(`public:effort:${LUCKY}`, effortFor(end), end);
  await recordPPLNSSnapshot(env.DB, saved);
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind("public:overview:v1", JSON.stringify(saved), end).run();
  const response = await call(env, "GET", "/v1/pools");
  assert.equal(response.status, 200);
  // 80 blocks a day for 100 expected was luck (1.25 blocks of work each): the fee remains.
  near(response.body.rows[0].payouts[0].realFeePercent, 2);
  assert.deepEqual(response.body.rows[0].payouts[0].realFeePeriod, { start: T0, end });
  // Five days of history: the day is published, the week and the fortnight are not yet.
  assert.deepEqual(Object.keys(response.body.rows[0].luck), ["24h"]);
  near(response.body.rows[0].luck["24h"].ratio, .8);
  assert.ok(!JSON.stringify(response.body).includes("segments"));
  assert.ok(!JSON.stringify(response.body).includes("poolBlocks"));
  assert.equal(env.DB.rows("SELECT * FROM groups").length, 0);
  const before = env.DB.one(`SELECT v FROM kv WHERE k='public:pplns:${LUCKY}'`).v;
  await recordPPLNSSnapshot(env.DB, { ...saved, stale: true });
  assert.equal(env.DB.one(`SELECT v FROM kv WHERE k='public:pplns:${LUCKY}'`).v, before);
});

test("PPLNS: cron records public observations every five minutes without a visiting client", async () => {
  setNow(T0);
  const net = installFetch(), env = makeEnv();
  net.overview = (url) => {
    if (url.hostname !== "lordofpearls.xyz") return new Response("unavailable", { status: 503 });
    if (url.pathname === "/pools") return new Response('<table class="section-table"><tr><th>Pool</th><th>Hashrate</th><th>Blocks</th><th>Fee</th><th>Payout</th></tr><tr><td><a href="https://pearl.alphapool.tech/">AlphaPool</a></td><td>1 PH/s</td><td>80</td><td>2%</td><td>PPLNS</td></tr></table>');
    return Response.json({ ts: Date.now() / 1000, network: { difficulty: 1000, avg_block_time_s: 235 },
      leaderboard: { recent_blocks: [{ reward: 1 }] },
      lifetime: { top: [{ blocks: Date.now() / 1000 === T0 ? 1000 : 1001, pool: { url: "https://pearl.alphapool.tech/" } }] } });
  };
  await tick(env);
  // Six feeds (MPS data needs a successful page first; Kryptex, HeroMiners and Pearl Fortune fail and are read
  // once more). The chain's orphans come from the explorer page the table already read.
  assert.equal(net.overviewRequests.length, 9);
  // Written by the time the cron run returns, though the overview hands the bookkeeping to waitUntil.
  const first = env.DB.one("SELECT v FROM kv WHERE k LIKE 'public:pplns:%'");
  assert.ok(first); assert.equal(JSON.parse(first.v).segments.length, 0);
  setNow(T0 + 60); await tick(env);
  assert.equal(net.overviewRequests.length, 9);
  setNow(T0 + 300); await tick(env);
  assert.equal(net.overviewRequests.length, 18);
  const next = JSON.parse(env.DB.one("SELECT v FROM kv WHERE k LIKE 'public:pplns:%'").v);
  assert.equal(next.segments.length, 1); assert.equal(next.segments[0].blocks, 1);
  assert.equal(env.DB.rows("SELECT * FROM groups").length, 0);
});

test("pool lists: each snapshot reads the newest blocks and, while short of a week, one older page", async () => {
  const env = makeEnv(), hero = "https://pearl.herominers.com/", end = T0 + 2 * DAY;
  const rows = [{ ...row, id: hero, name: "HeroMiners", payouts: [{ scheme: "PROP", solo: false, fee: 0 }] },
    { ...row, id: "https://pearlhash.xyz/", name: "PearlHash", payouts: [{ scheme: null, solo: false, fee: 1 }] }];
  // A block every ten minutes, 125 shares for difficulty 100 each; get_blocks?height=H: the ten before H.
  const entry = (h) => [`x:${T0 + h * 600}:100:125:125:x:unlocked:1:prl1p:eu:prop`, String(h)];
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  const asked = [];
  let down = false;
  const fetchJSON = async (url, budget) => {
    if (url.includes("lordofpearls")) return {};
    asked.push([url, budget]);
    if (down) throw new Error("upstream");
    const u = new URL(url);
    if (u.pathname === "/api/stats") return { pool: { blocks: range(80, 90).reverse().flatMap(entry) } };
    const below = Number(u.searchParams.get("height"));
    return range(Math.max(1, below - 10), below).reverse().flatMap(entry);
  };
  const stored = () => JSON.parse(env.DB.one(`SELECT v FROM kv WHERE k='public:effort:${hero}'`).v);
  setNow(end); await recordPPLNSSnapshot(env.DB, snapshot(end, { rows }), fetchJSON);
  // The first time: the newest blocks only (PearlHash has no list to read).
  assert.deepEqual(asked, [["https://pearl.herominers.com/api/stats", "HeroMiners"]]);
  assert.equal(stored().since, T0 + 80 * 600); assert.equal(stored().blocks.length, 10);
  near(stored().blocks[0][2], 1.25);
  // Then one older page a snapshot until the pool has nothing older.
  for (let i = 1; i <= 9; i++) { setNow(end + i * 300); await recordPPLNSSnapshot(env.DB, snapshot(end + i * 300, { rows }), fetchJSON); }
  assert.equal(asked[2][0], "https://pearl.herominers.com/api/get_blocks?height=80");
  assert.equal(asked[4][0], "https://pearl.herominers.com/api/get_blocks?height=70");
  assert.deepEqual(stored().blocks.map((b) => b[0]), range(1, 90));
  assert.equal(stored().since, T0 + 600);
  // After an outage the newest list no longer joins and starts again; the older page asked for in the
  // same round belonged below the old list, so it waits for the next round.
  let jump = true;
  const after = async (url, budget) => {
    if (url.includes("lordofpearls")) return {};
    asked.push([url, budget]);
    const u = new URL(url);
    if (u.pathname === "/api/stats") return { pool: { blocks: (jump ? range(200, 210) : range(80, 90)).reverse().flatMap(entry) } };
    return range(Math.max(1, Number(u.searchParams.get("height")) - 10), Number(u.searchParams.get("height"))).reverse().flatMap(entry);
  };
  const keep = stored(), short = { since: T0 + 85 * 600, blocks: keep.blocks.filter((x) => x[0] >= 85) };
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(`public:effort:${hero}`, JSON.stringify(short), end).run();
  setNow(end + 2700); await recordPPLNSSnapshot(env.DB, snapshot(end + 2700, { rows }), after);
  assert.equal(asked.at(-1)[0], "https://pearl.herominers.com/api/get_blocks?height=85");
  assert.deepEqual(stored().blocks.map((x) => x[0]), range(200, 210));
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(`public:effort:${hero}`, JSON.stringify(keep), end).run();
  // A failed read keeps what is stored.
  down = true; const before = stored();
  setNow(end + 3000); await recordPPLNSSnapshot(env.DB, snapshot(end + 3000, { rows }), fetchJSON);
  assert.deepEqual(stored(), before);
});

test("pool lists: rejected and solo blocks on a pool's pages do not stall the backfill", async () => {
  const env = makeEnv(), end = T0 + DAY, fortune = "https://pearlfortune.org/", hero = "https://pearl.herominers.com/";
  const rows = [{ ...row, id: fortune, name: "Pearl Fortune", payouts: [{ scheme: "PPLNS", solo: false, fee: 1 }] },
    { ...row, id: hero, name: "HeroMiners", payouts: [{ scheme: "PROP", solo: false, fee: 0 }] }];
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  // Pearl Fortune: blocks 1–120, 20 a page, newest first; 61–85 were rejected, so the page at our
  // count never reaches past our oldest block. HeroMiners: 70–79 are solo blocks.
  const fortuneList = range(1, 121).reverse().map((h) => ({ block_height: h, created_at: new Date((T0 + h * 600) * 1000).toISOString(),
    effort: 1, submit_status: h >= 61 && h <= 85 ? "rejected" : "confirmed" }));
  const entry = (h) => [`x:${T0 + h * 600}:100:125:125:x:unlocked:1:prl1p:eu:${h >= 70 && h < 80 ? "solo" : "prop"}`, String(h)];
  const asked = [];
  const fetchJSON = async (url) => {
    if (url.includes("lordofpearls")) return {};
    asked.push(url);
    const u = new URL(url);
    if (u.hostname === "pearlfortune.org") {
      const page = Number(u.searchParams.get("page"));
      return { data: { blocks: fortuneList.slice((page - 1) * 20, page * 20) } };
    }
    if (u.pathname === "/api/stats") return { pool: { blocks: range(80, 90).reverse().flatMap(entry) } };
    const below = Number(u.searchParams.get("height"));
    return range(Math.max(1, below - 10), below).reverse().flatMap(entry);
  };
  const stored = (id) => JSON.parse(env.DB.one(`SELECT v FROM kv WHERE k='public:effort:${id}'`).v);
  for (let i = 0; i <= 8; i++) { setNow(end + i * 300); await recordPPLNSSnapshot(env.DB, snapshot(end + i * 300, { rows }), fetchJSON); }
  // Every page once, in order, the all-rejected one included; then the next one down.
  assert.deepEqual(asked.filter((u) => u.includes("pearlfortune")).map((u) => new URL(u).searchParams.get("page")),
    ["1", "1", "2", "1", "3", "1", "4", "1", "5", "1", "6", "1", "7", "1", "8", "1", "9"]);
  assert.deepEqual(stored(fortune).blocks.map((b) => b[0]), [...range(1, 61), ...range(86, 121)]);
  // Below the solo page HeroMiners goes on from its lowest block, not from ours again.
  assert.deepEqual(asked.filter((u) => u.includes("get_blocks")).slice(0, 3),
    ["https://pearl.herominers.com/api/get_blocks?height=80", "https://pearl.herominers.com/api/get_blocks?height=70",
      "https://pearl.herominers.com/api/get_blocks?height=60"]);
  assert.deepEqual(stored(hero).blocks.map((b) => b[0]), [...range(1, 70), ...range(80, 90)]);
});

test("pool lists: the block lists, PearlHash and the explorer's orphans are asked for at once", async () => {
  const env = makeEnv(), end = T0 + DAY, hero = "https://pearl.herominers.com/";
  const rows = [{ ...row, id: hero, name: "HeroMiners", payouts: [{ scheme: "PROP", solo: false, fee: 0 }] },
    { ...row, id: "https://pearlhash.xyz/", name: "PearlHash", payouts: [{ scheme: null, solo: false, fee: 1 }] }];
  const started = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const fetchJSON = async (url) => {
    started.push(new URL(url).hostname);
    await gate;
    return url.includes("pearlhash") ? { hashrate_diff_5m: 1, hashrate: 1 } : url.includes("lordofpearls") ? {} : { pool: { blocks: [] } };
  };
  setNow(end);
  const done = recordPPLNSSnapshot(env.DB, snapshot(end, { rows, network: { ts: end, prlPerTHDay: .1, reward: 1, difficulty: 1000 } }), fetchJSON);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started.sort(), ["lordofpearls.xyz", "pearl.herominers.com", "pearlhash.xyz"]);
  open(); await done;
});

test("pool lists: a list that did not change is not written again", async () => {
  const env = makeEnv(), end = T0 + DAY, jetski = "https://pearl.jetskipool.ai/";
  const rows = [{ ...row, id: jetski, name: "Jetski", payouts: [{ scheme: "PPLNS", solo: false, fee: 1 }] }];
  const blocks = Array.from({ length: 5 }, (_, i) => ({ height: 100 - i, time: end - 600 * (i + 1), effort: 1, lifecycle_status: "confirmed" }));
  const fetchJSON = async (url) => url.includes("lordofpearls") ? {} : { recent_blocks_found: blocks };
  const written = () => env.DB.one(`SELECT ts FROM kv WHERE k='public:effort:${jetski}'`).ts;
  setNow(end); await recordPPLNSSnapshot(env.DB, snapshot(end, { rows }), fetchJSON);
  assert.equal(written(), end);
  setNow(end + 300); await recordPPLNSSnapshot(env.DB, snapshot(end + 300, { rows }), fetchJSON);
  assert.equal(written(), end);
  blocks.unshift({ height: 101, time: end + 200, effort: 2, lifecycle_status: "confirmed" });
  setNow(end + 600); await recordPPLNSSnapshot(env.DB, snapshot(end + 600, { rows }), fetchJSON);
  assert.equal(written(), end + 600);
});

test("pool lists: Lucky Pool's daily totals are read while its list is short of a week, and kept with it", async () => {
  const env = makeEnv(), end = T0 + 3 * DAY;
  const rows = [{ ...row, id: LUCKY, name: "Lucky Pool" }];
  const entry = (h) => [`x:${T0 + h * 600}:100:125:0:1:0`, String(h)];
  const asked = [];
  const fetchJSON = async (url, budget) => {
    if (url.includes("lordofpearls")) return {};
    asked.push([url, budget]);
    if (url.endsWith("/api/stats")) return { pool: { blocks: [300, 301, 302].reverse().flatMap(entry) } };
    return { data: [0, 1, 2].map((d) => ({ date: T0 + (d + 1) * DAY - 1, effort: 1.25, block: 80, solo: 0, orphan: 0 })) };
  };
  const stored = () => JSON.parse(env.DB.one(`SELECT v FROM kv WHERE k='public:effort:${LUCKY}'`).v);
  setNow(end); await recordPPLNSSnapshot(env.DB, snapshot(end, { rows }), fetchJSON);
  assert.deepEqual(asked.map((a) => a[0]), ["https://pearl.luckypool.io/api/stats"]);
  assert.equal(stored().days, undefined);
  setNow(end + 300); await recordPPLNSSnapshot(env.DB, snapshot(end + 300, { rows }), fetchJSON);
  assert.deepEqual(asked.slice(1), [["https://pearl.luckypool.io/api/stats", "Lucky Pool"], ["https://pearl.luckypool.io/api/block-stats", "Lucky Pool"]]);
  assert.deepEqual(stored().days, [[T0, 80, 100, 0], [T0 + DAY, 80, 100, 0], [T0 + 2 * DAY, 80, 100, 0]]);
  // The next newest list keeps them; a list that covers the week stops reading them.
  setNow(end + 600); await recordPPLNSSnapshot(env.DB, snapshot(end + 600, { rows }), fetchJSON);
  assert.equal(stored().days.length, 3);
  const covered = { ...stored(), since: end + 600 - 8 * DAY };
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(`public:effort:${LUCKY}`, JSON.stringify(covered), end).run();
  const before = asked.length;
  setNow(end + 900); await recordPPLNSSnapshot(env.DB, snapshot(end + 900, { rows }), fetchJSON);
  assert.deepEqual(asked.slice(before).map((a) => a[0]), ["https://pearl.luckypool.io/api/stats"]);
});

test("PearlHash: per UTC day, the blocks found and the blocks its share rate and its display each predict", () => {
  // Difficulty 1000; a share rate of 0.01 units a second predicts 0.01 × 300 / 1000 = 0.003 blocks in five minutes.
  const p = (ts, blocks, changes = {}) => ({ ts, blocks, diffRate: .01, display: .01 * 2 ** 48 * .915, difficulty: 1000, ...changes });
  let w;
  for (let ts = T0; ts <= T0 + DAY; ts += 300) w = extendPearlHashWork(w, p(ts, 1000 + Math.floor((ts - T0) / 30000)));
  assert.equal(w.days.length, 2);
  const [d0, d1] = w.days;
  assert.equal(d0[0], T0); assert.equal(d0[1], DAY - 300); assert.equal(d1[0], T0 + DAY); assert.equal(d1[1], 300);
  near(d0[3], .01 * (DAY - 300) / 1000); near(d0[4], d0[3] * .915);
  assert.equal(d0[2] + d1[2], 2);
  // A gap, a counter that went back or a jump leaves the interval out but keeps the point.
  const end = w.last.ts;
  for (const next of [p(end + 1801, 1002), p(end + 300, 1000), p(end + 300, 1100)]) {
    const v = extendPearlHashWork(w, next);
    assert.deepEqual(v.days, w.days); assert.equal(v.last.ts, next.ts);
  }
  // Repeated or older points and unreadable values change nothing.
  assert.equal(extendPearlHashWork(w, p(end, 1002)), w);
  assert.equal(extendPearlHashWork(w, p(end + 300, 1002, { diffRate: null })), w);
  // Sixty days are kept.
  let long;
  for (let ts = T0; ts <= T0 + 70 * DAY; ts += 1800) long = extendPearlHashWork(long, p(ts, 1000));
  assert.ok(long.days.length <= 61 && long.days[0][0] >= T0 + 10 * DAY - DAY);
});

test("PearlHash: a snapshot reads its /api/stats under its budget and stores the day totals", async () => {
  const env = makeEnv(), end = T0 + DAY;
  const ph = { ...row, id: "https://pearlhash.xyz/", name: "PearlHash", payouts: [{ scheme: null, solo: false, fee: 1 }] };
  const asked = [];
  const fetchJSON = async (url, budget) => { if (url.includes("lordofpearls")) return {}; asked.push([url, budget]); return { hashrate: 1.4e19, hashrate_diff_5m: 54000 }; };
  const stored = () => JSON.parse(env.DB.one("SELECT v FROM kv WHERE k='public:pearlhash-work:v1'")?.v || "null");
  const snap = (ts, blocks) => snapshot(ts, { rows: [{ ...ph, lifetimeBlocks: blocks }], network: { ts, prlPerTHDay: .1, reward: 1, difficulty: 4e7 } });
  setNow(end); await recordPPLNSSnapshot(env.DB, snap(end, 500), fetchJSON);
  assert.deepEqual(asked, [["https://pearlhash.xyz/api/stats", "PearlHash"]]);
  assert.deepEqual(stored().days, []); assert.equal(stored().last.diffRate, 54000);
  setNow(end + 300); await recordPPLNSSnapshot(env.DB, snap(end + 300, 501), fetchJSON);
  const [d] = stored().days;
  assert.equal(d[0], end); assert.equal(d[1], 300); assert.equal(d[2], 1);
  near(d[3], 54000 * 300 / 4e7); near(d[4], 1.4e19 * 300 / (4e7 * 2 ** 48));
  // No fetcher (a cached read) or a failed read: nothing recorded, nothing else disturbed.
  await recordPPLNSSnapshot(env.DB, snap(end + 600, 502));
  assert.equal(stored().last.ts, end + 300);
  setNow(end + 900); await recordPPLNSSnapshot(env.DB, snap(end + 900, 503), async () => { throw new Error("busy"); });
  assert.equal(stored().last.ts, end + 300);
  // Never in the public answer.
  const { pplns, luck } = await readPoolLuck(env.DB, end + 900);
  assert.ok(!JSON.stringify({ pplns, luck: [...luck] }).includes("diffRate"));
});

test("chain orphans: the explorer's orphan list, named by pool URL or a checked address, with hourly block counters", () => {
  const KRYPTEX = "https://prl.kryptex.network/", JETSKI = "https://pearl.jetskipool.ai/";
  const rows = [{ id: KRYPTEX, name: "Kryptex", solo: false, lifetimeBlocks: 1000 }, { id: JETSKI, name: "Jetski", solo: false, lifetimeBlocks: 50 },
    { id: "https://www.f2pool.com/", name: "F2Pool", solo: false, lifetimeBlocks: null }, { id: "solo", name: "X SOLO", solo: true, lifetimeBlocks: 5 }];
  const o = (hash, ts, extra = {}) => ({ hash, height: 100 + ts % 1000, detected_at: ts, reward: 1, branchlen: 1, miner: "prl1punknown", ...extra });
  const k = { pool: { url: "https://prl.kryptex.network/", name: "Kryptex Pool" } };
  const jet = { miner: "prl1pgr2znrzz8nwu2lrw4phrzaqqa8ukt76qsqc29wxgcwgalanur7zsk8w070" };
  let c = extendChainOrphans(null, [o("a", T0 - 100, k), o("b", T0 - 50, jet), o("c", T0 - 10)], rows, T0);
  assert.equal(c.since, T0 - 100);
  assert.deepEqual(c.orphans.map((x) => [x[0], x[3]]), [["a", KRYPTEX], ["b", JETSKI], ["c", null]]);
  assert.deepEqual(c.counters, { [KRYPTEX]: [[T0, 1000]], [JETSKI]: [[T0, 50]] }); // no counter: F2Pool; SOLO: never
  // Overlapping reads join (no duplicates); a counter point at most once an hour.
  c = extendChainOrphans(c, [o("c", T0 - 10), o("d", T0 + 200, k)], rows.map((r) => ({ ...r, lifetimeBlocks: r.lifetimeBlocks && r.lifetimeBlocks + 1 })), T0 + 300);
  assert.deepEqual(c.orphans.map((x) => x[0]), ["a", "b", "c", "d"]); assert.equal(c.counters[KRYPTEX].length, 1);
  c = extendChainOrphans(c, [], rows.map((r) => ({ ...r, lifetimeBlocks: r.lifetimeBlocks && r.lifetimeBlocks + 30 })), T0 + 3600);
  assert.deepEqual(c.counters[KRYPTEX], [[T0, 1000], [T0 + 3600, 1030]]);
  // A read that shares nothing with the stored list and starts after it: orphans may be missing, so it starts again.
  const gap = extendChainOrphans(c, [o("x", T0 + 5000, k), o("y", T0 + 5100, k)], rows, T0 + 5200);
  assert.deepEqual(gap.orphans.map((x) => x[0]), ["x", "y"]); assert.equal(gap.since, T0 + 5000);
  // A counter that went back starts that pool again; a pool seen first takes earlier points from its seed.
  const back = extendChainOrphans(c, [], rows.map((r) => r.id === KRYPTEX ? { ...r, lifetimeBlocks: 10 } : r), T0 + 7200);
  assert.deepEqual(back.counters[KRYPTEX], [[T0 + 7200, 10]]);
  const seeded = extendChainOrphans(null, [], [{ id: "p", name: "P", solo: false, lifetimeBlocks: 90 }], T0 + 10 * DAY,
    () => [[T0 + 2 * DAY, 10], [T0 + 5 * DAY, 40], [T0 + 9 * DAY, 80]]);
  assert.deepEqual(seeded.counters.p, [[T0 + 2 * DAY, 10], [T0 + 5 * DAY, 40], [T0 + 9 * DAY, 80], [T0 + 10 * DAY, 90]]);
});

test("chain orphans: a history seeds counter points back to its last hole, an hour apart", () => {
  // Readings every five minutes, a block every ten: three hours, a two-hour gap in which the pool
  // found 30 blocks, then three more hours.
  let h = null, blocks = 1000;
  const read = (ts) => { h = extendPPLNSHistory(h, "alpha", "AlphaPool", { ts, hashPH: 1, unit: 100, reward: 1, fee: 2, blocks }); };
  for (let ts = T0; ts <= T0 + 3 * 3600; ts += 300) { read(ts); if ((ts - T0) % 600 === 300) blocks++; }
  blocks += 30;
  const after = T0 + 5 * 3600;
  for (let ts = after; ts <= after + 3 * 3600; ts += 300) { read(ts); if ((ts - after) % 600 === 300) blocks++; }
  const pts = counterSeed(h, null, after + 4 * 3600);
  // Nothing from before the gap: those counts would be 30 too high.
  assert.deepEqual(pts.map((p) => p[0]), [after, after + 3600, after + 7200, after + 3 * 3600]);
  assert.deepEqual(pts.map((p) => p[1]), [h.last.blocks - 18, h.last.blocks - 12, h.last.blocks - 6, h.last.blocks]);
  // A history that ends in a hole seeds only its last reading.
  const holed = extendPPLNSHistory(h, "alpha", "AlphaPool", { ...h.last, ts: h.last.ts + 3600, blocks: h.last.blocks + 4 });
  assert.deepEqual(counterSeed(holed, null, holed.last.ts + 60), [[holed.last.ts, holed.last.blocks]]);
});

test("chain orphans: a PPS pool with no history starts from the explorer's 24-hour count, then grows to the week", async () => {
  const env = makeEnv(), id = "https://prl.kryptex.network/", end = T0 + 3 * DAY; setNow(end);
  const kryptex = { id, name: "Kryptex", solo: false, hashrate: 1e15, lifetimeBlocks: 5000, source: "lordofpearls", sampleDays: 1, blocksSample: 250,
    payouts: [{ scheme: "PPS+", solo: false, fee: 3, grossPerPH: 100, realFeePercent: null }] };
  const recent = [1, 2, 3].map((i) => ({ hash: `k${i}`, height: i, detected_at: end - i * 3600, miner: "x", pool: { url: id } }))
    .concat([{ hash: "old", height: 0, detected_at: end - 2 * DAY, miner: "x", pool: { url: id } }]);
  const fetchJSON = async (url) => url.includes("lordofpearls") ? { orphans: { recent } } : {};
  await recordPPLNSSnapshot(env.DB, snapshot(end, { rows: [kryptex] }), fetchJSON);
  const stored = JSON.parse(env.DB.one("SELECT v FROM kv WHERE k='public:chain-orphans:v1'").v);
  assert.deepEqual(stored.counters[id], [[end - DAY, 4750], [end, 5000]]);
  const summary = JSON.parse(env.DB.one("SELECT v FROM kv WHERE k='public:pool-luck:v1'").v);
  // The last day: 3 orphans the node saw (not the one two days ago) against 250 chain blocks.
  assert.deepEqual(summary.rows[0].orphans, { start: end - DAY, end, blocks: 253, orphans: 3, source: "chain" });
});

test("chain orphans: a week's rate is orphans ÷ (chain blocks + orphans); the higher of the pool's and the chain's is served", async () => {
  const end = T0 + 9 * DAY, id = "https://prl.kryptex.network/";
  // Ten blocks an hour on chain for nine days; an orphan every 50 blocks the explorer saw.
  const counters = { [id]: Array.from({ length: 9 * 24 + 1 }, (_, h) => [T0 + h * 3600, 1000 + 10 * h]) };
  const orphans = Array.from({ length: 9 * 24 * 10 / 50 }, (_, i) => [`h${i}`, T0 + i * 5 * 3600 + 1, i, id]);
  const chain = { since: T0, orphans, counters };
  const w = chainOrphanWindow(chain, id, end);
  assert.equal(w.start, end - 7 * DAY); assert.equal(w.source, "chain");
  assert.equal(w.orphans, 7 * 24 / 5 | 0); assert.equal(w.blocks, 7 * 24 * 10 + w.orphans);
  // Not before a day of counters, nor when the explorer's list starts late, nor from under 20 blocks.
  assert.equal(chainOrphanWindow({ ...chain, counters: { [id]: counters[id].slice(-20) } }, id, end), null);
  assert.equal(chainOrphanWindow({ ...chain, since: end - 3600 }, id, end), null);
  assert.equal(chainOrphanWindow({ since: T0, orphans: [], counters: { [id]: [[end - 2 * DAY, 0], [end, 10]] } }, id, end), null);
  assert.equal(chainOrphanWindow(chain, "other", end), null);

  // Through the snapshot: Lucky's own list shows none, the explorer saw some, so the chain's rate is served;
  // Kryptex (PPS, no list) gets the chain's; a pool whose own list shows more keeps its own.
  const env = makeEnv(); setNow(end);
  const put = (k, v) => env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(k, JSON.stringify(v), end).run();
  const lucky = { ...row, id: LUCKY, name: "Lucky Pool", lifetimeBlocks: point(end).blocks };
  const hero = { ...row, id: "https://pearl.herominers.com/", name: "HeroMiners", lifetimeBlocks: point(end).blocks };
  const kryptex = { id, name: "Kryptex", solo: false, hashrate: 1e15, lifetimeBlocks: 1000 + 10 * 9 * 24,
    payouts: [{ scheme: "PPS+", solo: false, fee: 3, grossPerPH: 100, realFeePercent: null }] };
  await put(`public:effort:${LUCKY}`, effortFor(end, { since: end - 7 * DAY }));
  const heroList = effortFor(end, { since: end - 7 * DAY }); heroList.blocks = heroList.blocks.map((b, i) => i % 10 ? b : [b[0], b[1], b[2], 1]);
  await put("public:effort:https://pearl.herominers.com/", heroList);
  const luckyCounters = Array.from({ length: 8 * 24 + 1 }, (_, h) => [end - 8 * DAY + h * 3600, point(end - 8 * DAY + h * 3600).blocks]);
  await put("public:chain-orphans:v1", { since: T0, orphans: [...orphans, ["l1", end - DAY, 1, LUCKY], ["l2", end - 2 * DAY, 2, LUCKY],
    ["hh", end - DAY, 3, "https://pearl.herominers.com/"]], counters: { ...counters, [LUCKY]: luckyCounters, "https://pearl.herominers.com/": luckyCounters } });
  const saved = snapshot(end, { rows: [lucky, hero, kryptex] });
  await recordPPLNSSnapshot(env.DB, saved);
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind("public:overview:v1", JSON.stringify(saved), end).run();
  const rows = (await call(env, "GET", "/v1/pools")).body.rows, by = (x) => rows.find((r) => r.id === x);
  assert.equal(by(LUCKY).orphans.source, "chain"); assert.equal(by(LUCKY).orphans.orphans, 2);
  assert.equal(by(id).orphans.source, "chain"); assert.equal(by(id).orphans.orphans, w.orphans); assert.equal(by(id).luck, null);
  assert.equal(by("https://pearl.herominers.com/").orphans.source, "pool"); assert.ok(by("https://pearl.herominers.com/").orphans.orphans > 1);
  assert.ok(!JSON.stringify(rows).includes("counters"));
});

test("luck: shared-reward contracts are sampled, including an unnamed scheme; PPS, PPS+, FPPS and SOLO are not", () => {
  const scheme = (...names) => sharedPayout({ solo: false, payouts: names.map((n) => ({ scheme: n, solo: false, fee: 1 })) })?.scheme;
  assert.equal(scheme("PPLNS"), "PPLNS");
  assert.equal(scheme("PROP"), "PROP");
  assert.equal(scheme(null), null);                     // PearlHash: the explorer names no scheme
  assert.equal(scheme("PPS", "PPLNS"), "PPLNS");        // Pearl Fortune's two contracts
  for (const name of ["PPS", "PPS+", "FPPS", "SOLO", " pps "]) assert.equal(scheme(name), undefined);
  assert.equal(sharedPayout({ solo: true, payouts: [{ scheme: "PPLNS", fee: 1 }] }), null);
  assert.deepEqual(pplnsPoint(snapshot(), { ...row, payouts: [{ scheme: null, solo: false, fee: 2 }] }), point(T0));
});

test("cost estimate: PPLNS and PROP by name, and PearlHash's unnamed scheme it pays out by block; nothing else", async () => {
  const pay = (scheme, extra = {}) => ({ scheme, solo: false, fee: 1, ...extra });
  const pearlhash = { id: "https://pearlhash.xyz/", name: "PearlHash", solo: false };
  for (const name of ["PPLNS", " pplns ", "PROP", "prop"]) assert.equal(costEstimated(row, pay(name)), true, name);
  assert.equal(costEstimated(pearlhash, pay(null)), true);
  assert.equal(costEstimated(pearlhash, pay("")), true);
  assert.equal(costEstimated(row, pay(null)), false);                     // an unnamed scheme elsewhere
  for (const name of ["PPS", "PPS+", "FPPS", "SOLO", "PPLNT"]) assert.equal(costEstimated(pearlhash, pay(name)), false, name);
  assert.equal(costEstimated({ ...pearlhash, solo: true }, pay(null)), false);
  assert.equal(costEstimated(pearlhash, pay(null, { solo: true })), false);
  assert.equal(costEstimated(pearlhash, null), false);
  // Six days of samples: the summary carries an estimate for a PROP pool that publishes its blocks'
  // effort; PearlHash publishes none, and luck cannot be taken out of an unnamed pool's blocks.
  const env = makeEnv(), hero = "https://pearl.herominers.com/", rows = [
    { ...row, id: hero, name: "HeroMiners", payouts: [pay("PROP", { fee: 2, grossPerPH: 80, realFeePercent: null })] },
    { ...row, id: pearlhash.id, name: "PearlHash", payouts: [pay(null, { fee: 2, grossPerPH: 80, realFeePercent: null })] },
    { ...row, id: "unnamed", name: "Unnamed", payouts: [pay(null, { fee: 2, grossPerPH: 80, realFeePercent: null })] }];
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind(`public:effort:${hero}`, JSON.stringify(effortFor(T0 + 6 * DAY)), T0).run();
  for (let ts = T0; ts <= T0 + 6 * DAY; ts += 300) {
    setNow(ts);
    await recordPPLNSSnapshot(env.DB, snapshot(ts, { rows: rows.map((r) => ({ ...r, lifetimeBlocks: 1000 + Math.floor((ts - T0) / 1080) })) }));
  }
  const { pplns, luck } = await readPoolLuck(env.DB, T0 + 6 * DAY);
  assert.deepEqual(pplns.map((m) => m.pool), ["HeroMiners"]);
  near((1 - pplns[0].ratio) * 100, 2);
  assert.equal(luck.size, 3);
});

test("luck: each window needs 90% of its span observed; ratio, gross and theory per PH·day", () => {
  // 80 blocks a day where the work should find 100.
  const check = (w, span) => {
    near(w.ratio, .8); near(w.grossPerPH, 80); near(w.theoreticalPerPH, 100);
    near(w.expectedBlocks, 100 * span / DAY); assert.equal(w.blocks, 80 * span / DAY);
  };
  assert.deepEqual(luckWindows(history(.5), T0 + .5 * DAY), {});
  const day = luckWindows(history(3), T0 + 3 * DAY);
  assert.deepEqual(Object.keys(day), ["24h"]); check(day["24h"], DAY);
  const all = luckWindows(history(15), T0 + 15 * DAY);
  assert.deepEqual(Object.keys(all), ["24h", "7d", "14d"]);
  check(all["24h"], DAY); check(all["7d"], 7 * DAY);
  assert.ok(all["14d"].covered >= .9 * 14 * DAY && all["14d"].end - all["14d"].start <= 14 * DAY);
  near(all["14d"].ratio, .8, 1e-3);
  // A three-hour hole in the last day: the day is too incomplete, the week is not.
  let h = history(8);
  for (let ts = h.last.ts + 3 * 3600; ts <= T0 + 9 * DAY; ts += 300) h = extendPPLNSHistory(h, "alpha", "AlphaPool", point(ts));
  assert.deepEqual(Object.keys(luckWindows(h, h.last.ts)), ["7d"]);
  // Stale or future histories publish nothing.
  assert.deepEqual(luckWindows(history(3), T0 + 3 * DAY + 1801), {});
  assert.deepEqual(luckWindows(history(3), T0 + 3 * DAY - 61), {});
});

test("luck: segments recorded before gross and work were stored derive them from the pool's fee and yield", () => {
  const fresh = history(8);
  const old = structuredClone(fresh);
  for (const s of old.segments) { delete s.grossPRL; delete s.work; }
  const a = luckWindows(fresh, fresh.last.ts), b = luckWindows(old, old.last.ts);
  for (const name of ["24h", "7d"]) for (const k of ["ratio", "grossPerPH", "theoreticalPerPH", "expectedBlocks"]) near(a[name][k], b[name][k]);
  // New observations never merge into an old segment, whose totals would lose the new fields.
  const next = extendPPLNSHistory(old, "alpha", "AlphaPool", point(old.last.ts + 300));
  assert.equal(next.segments.length, old.segments.length + 1);
  assert.equal(next.segments.at(-1).work, 300 / DAY);
  assert.equal(next.segments.at(-2).work, undefined);
});

test("luck: frequent holes keep the history bounded and valid", () => {
  let h = history(1), ts = h.last.ts;
  // A hole, then one observed interval, for two weeks: hundreds of short segments.
  while (ts < T0 + 15 * DAY) {
    ts += 1801; h = extendPPLNSHistory(h, "alpha", "AlphaPool", point(ts));
    ts += 300; h = extendPPLNSHistory(h, "alpha", "AlphaPool", point(ts));
  }
  assert.ok(h.segments.length <= 400 && h.segments.length >= 399);
  // Still a valid history: extending it keeps the segments instead of starting over.
  const next = extendPPLNSHistory(h, "alpha", "AlphaPool", point(ts + 300));
  assert.ok(next.segments.length >= 399 && next.segments.length <= 400);
  assert.equal(next.segments.at(-1).end, ts + 300);
});

test("luck: a renamed pool keeps its history — Pearlski's samples carry on as Jetski", async () => {
  const old = { ...history(6), id: "jetski", pool: "Pearlski" };
  const next = extendPPLNSHistory(old, "jetski", "Jetski", point(old.last.ts + 300));
  assert.equal(next.pool, "Jetski");
  assert.equal(next.segments.at(-1).end, old.last.ts + 300);
  assert.ok(next.segments.length >= old.segments.length);
  // A cached read (no new work) still moves the stored history to the new name, once.
  const same = extendPPLNSHistory(old, "jetski", "Jetski", old.last);
  assert.notEqual(same, old);
  assert.deepEqual(same, { ...old, pool: "Jetski" });
  assert.equal(extendPPLNSHistory(same, "jetski", "Jetski", old.last), same);
  // Only that rename: any other name change still starts over, and it never runs backwards.
  assert.deepEqual(extendPPLNSHistory(old, "jetski", "Other", point(old.last.ts + 300)).segments, []);
  assert.deepEqual(extendPPLNSHistory({ ...old, pool: "Jetski" }, "jetski", "Pearlski", point(old.last.ts + 300)).segments, []);
  assert.deepEqual(extendPPLNSHistory({ ...old, pool: "constructor" }, "jetski", "Jetski", point(old.last.ts + 300)).segments, []);

  // A summary recorded under the old name serves the renamed row until the next snapshot.
  const env = makeEnv(), end = T0 + 8 * DAY; setNow(end);
  const ski = { id: "jetski", name: "Jetski", solo: false, hashrate: 1e15, lifetimeBlocks: point(end).blocks,
    payouts: [{ scheme: "PPLNS", solo: false, fee: 2, grossPerPH: 80, realFeePercent: null }] };
  // What the old code left behind: the history and the summary, both under "Pearlski".
  const kept = { ...historyTo(end), id: "jetski", pool: "Pearlski" };
  const put = (k, v) => env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(k, JSON.stringify(v), end).run();
  await put("public:pplns:jetski", kept);
  await put("public:pool-luck:v1", { ts: end, rows: [{ id: "jetski", pool: "Pearlski", luck: luckWindows(kept, end), pplns: pplnsMeasurement(kept, end, effortFor(end)) }] });
  const read = await readPoolLuck(env.DB, end);
  assert.equal(read.luck.get("jetski").pool, "Jetski");
  assert.equal(read.pplns[0].pool, "Jetski");
  const { attachLuck } = await import("../src/pplns.js");
  near(attachLuck({ rows: [ski] }, read.luck).rows[0].luck["7d"].ratio, .8);
  assert.equal(attachLuck({ rows: [{ ...ski, name: "Other" }] }, read.luck).rows[0].luck, null);
  // The next snapshot under the new name keeps every recorded segment.
  const before = JSON.parse((await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind("public:pplns:jetski").first()).v);
  setNow(end + 300);
  await recordPPLNSSnapshot(env.DB, snapshot(end + 300, { rows: [{ ...ski, lifetimeBlocks: point(end + 300).blocks }] }));
  const after = JSON.parse((await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind("public:pplns:jetski").first()).v);
  assert.equal(after.pool, "Jetski");
  assert.ok(after.segments.length >= before.segments.length && after.segments[0].start === before.segments[0].start);
});

test("luck: windows reach the API by id and pool name, from a recorded summary that expires with the snapshot", async () => {
  const env = makeEnv(), end = T0 + 8 * DAY; setNow(end);
  const hash = { id: "hash", name: "PearlHash", solo: false, hashrate: 1e15, lifetimeBlocks: point(end).blocks,
    payouts: [{ scheme: null, solo: false, fee: 1, grossPerPH: 70, realFeePercent: null }] };
  const pps = { id: "kryptex", name: "Kryptex", solo: false, hashrate: 1e15, lifetimeBlocks: point(end).blocks,
    payouts: [{ scheme: "PPS+", solo: false, fee: 3, grossPerPH: 100, realFeePercent: null }] };
  const store = (id, pool) => env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind(`public:pplns:${id}`, JSON.stringify({ ...historyTo(end - 300), id, pool }), end).run();
  await store(LUCKY, "Lucky Pool"); await store("hash", "PearlHash"); await store("kryptex", "Kryptex");
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind(`public:effort:${LUCKY}`, JSON.stringify(effortFor(end, { effort: 1.1 })), end).run();
  const saved = snapshot(end, { rows: [{ ...row, id: LUCKY, name: "Lucky Pool", lifetimeBlocks: point(end).blocks }, hash, pps] });
  await recordPPLNSSnapshot(env.DB, saved);
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind("public:overview:v1", JSON.stringify(saved), end).run();
  const rows = (await call(env, "GET", "/v1/pools")).body.rows;
  const by = (id) => rows.find((r) => r.id === id);
  assert.deepEqual(Object.keys(by(LUCKY).luck), ["24h", "7d"]);
  // Luck stays in the luck windows; Real Cost is fee and lost work: 0.8 blocks for 1.1 blocks' work
  // each is luck 0.909, and 0.88 of the displayed work became shares.
  near(by(LUCKY).luck["7d"].ratio, .8);
  near(by(LUCKY).payouts[0].realFeePercent, (1 - .98 * .88) * 100, 1e-6);
  // An unnamed scheme gets luck but no PPLNS cost estimate; a PPS row gets neither.
  near(by("hash").luck["7d"].ratio, .8);
  assert.equal(by("hash").payouts[0].realFeePercent, null);
  assert.equal(by("kryptex").luck, null);
  // The summary is keyed by id and checked against the row's name.
  const luck = (await readPoolLuck(env.DB, end)).luck;
  assert.equal(luck.get("hash").pool, "PearlHash");
  const { attachLuck } = await import("../src/pplns.js");
  assert.equal(attachLuck({ rows: [{ ...hash, name: "Renamed" }] }, luck).rows[0].luck, null);
  // Half an hour without a recorded snapshot and nothing is served.
  assert.equal((await readPoolLuck(env.DB, end + 1801)).luck.size, 0);
  assert.deepEqual((await readPoolLuck(env.DB, end + 1801)).pplns, []);
});

test("orphans: a pool's own blocks over the last week, with its daily totals while its list is short", () => {
  const end = T0 + 9 * DAY;
  // A list longer than the week, each block followed by one that lost the race: half are orphans.
  const full = orphanWindow(effortFor(end, { orphans: true }), end);
  assert.equal(full.start, end - 7 * DAY); assert.equal(full.end, end);
  assert.equal(full.blocks, 2 * full.orphans); assert.equal(full.orphans, 561); // 7 × 80, and one exactly at the start
  // Counted only from where the list is complete; our own sampling plays no part.
  const recent = effortFor(end, { since: end - 2 * DAY });
  assert.deepEqual(orphanWindow(recent, end), { start: end - 2 * DAY, end, blocks: recent.blocks.length, orphans: 0, source: "pool" });
  // Fewer than 20 blocks, or less than a day, or nothing readable: no rate.
  assert.equal(orphanWindow(effortFor(end, { since: end - 5 * 3600 }), end), null);
  const dense = { since: end - 3600, blocks: Array.from({ length: 30 }, (_, i) => [100 + i, end - 3500 + i * 100, 1, i % 2]) };
  assert.equal(orphanWindow(dense, end), null);
  for (const bad of [null, { since: end, blocks: [] }, { since: end, blocks: [[1, end, 1, 2]] }]) assert.equal(orphanWindow(bad, end), null);
  // Lucky Pool: its daily totals stand in for the whole days before a short list.
  const since = T0 + 7 * DAY + 3600, list = effortFor(end, { since }).blocks;
  const days = [2, 3, 4, 5, 6, 7].map((d) => [T0 + d * DAY, 80, 100, 2]);
  const onFirstDay = list.filter((b) => b[1] < T0 + 8 * DAY).length;
  assert.deepEqual(orphanWindow({ since, blocks: list, days }, end),
    { start: T0 + 2 * DAY, end, blocks: 5 * 80 + (80 - onFirstDay) + list.length, orphans: 12, source: "pool" });
  // A missing day: the list alone.
  assert.equal(orphanWindow({ since, blocks: list, days: days.filter((d) => d[0] !== T0 + 4 * DAY) }, end).start, since);
  // What a summary may serve.
  const ok = { start: end - 7 * DAY, end, blocks: 100, orphans: 3 };
  assert.ok(validOrphans(ok, end));
  for (const changes of [{ orphans: 101 }, { orphans: -1 }, { blocks: 19, orphans: 0 }, { blocks: 1.5 }, { start: end - 3600 },
    { start: end - 8 * DAY }, { end: end - 1801, start: end - 1801 - 7 * DAY }]) assert.equal(validOrphans({ ...ok, ...changes }, end), false);
});

test("orphans: rows with a pool block list carry its orphan count; the others carry null", async () => {
  const env = makeEnv(), end = T0 + 8 * DAY; setNow(end);
  const pps = { id: "kryptex", name: "Kryptex", solo: false, hashrate: 1e15, lifetimeBlocks: point(end).blocks,
    payouts: [{ scheme: "PPS+", solo: false, fee: 3, grossPerPH: 100, realFeePercent: null }] };
  const other = { ...row, id: "other", name: "Other", lifetimeBlocks: point(end).blocks };
  const put = (k, v) => env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(k, JSON.stringify(v), end).run();
  await put(`public:pplns:${LUCKY}`, { ...historyTo(end - 300), id: LUCKY, pool: "Lucky Pool" });
  await put("public:pplns:other", { ...historyTo(end - 300), id: "other", pool: "Other" });
  // Every 20th block lost the race.
  const effort = effortFor(end, { since: end - 7 * DAY });
  effort.blocks = effort.blocks.map((b, i) => i % 20 ? b : [b[0], b[1], b[2], 1]);
  await put(`public:effort:${LUCKY}`, effort);
  const saved = snapshot(end, { rows: [{ ...row, id: LUCKY, name: "Lucky Pool", lifetimeBlocks: point(end).blocks }, other, pps] });
  await recordPPLNSSnapshot(env.DB, saved);
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind("public:overview:v1", JSON.stringify(saved), end).run();
  const rows = (await call(env, "GET", "/v1/pools")).body.rows, by = (id) => rows.find((r) => r.id === id);
  assert.deepEqual(by(LUCKY).orphans, { start: end - 7 * DAY, end, blocks: effort.blocks.length, orphans: Math.ceil(effort.blocks.length / 20), source: "pool" });
  assert.equal(by("other").orphans, null);   // no block list of its own, and no chain record yet
  assert.equal(by("kryptex").orphans, null); // PPS: nothing recorded yet
  assert.ok(by("other").luck);               // its luck is unaffected
  // Checked against the row's name; a SOLO row never gets one; expires with the summary.
  const luck = (await readPoolLuck(env.DB, end)).luck;
  assert.equal(attachLuck({ rows: [{ ...by(LUCKY), name: "Renamed" }] }, luck).rows[0].orphans, null);
  assert.equal(attachLuck({ rows: [{ ...by(LUCKY), solo: true }] }, luck).rows[0].orphans, null);
  assert.equal((await readPoolLuck(env.DB, end + 1801)).luck.size, 0);
  // A summary holding only an orphan count still serves it, with no luck windows.
  await put("public:pool-luck:v1", { ts: end, rows: [{ id: LUCKY, pool: "Lucky Pool", luck: {}, pplns: null, orphans: { start: end - 2 * DAY, end, blocks: 40, orphans: 1 } }] });
  const only = attachLuck({ rows: [by(LUCKY)] }, (await readPoolLuck(env.DB, end)).luck).rows[0];
  assert.equal(only.luck, null); assert.deepEqual(only.orphans, { start: end - 2 * DAY, end, blocks: 40, orphans: 1, source: "pool" });
});
