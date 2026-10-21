import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fortuneDays, kryptexDays, f2poolDays, calculateMeasurement, validMeasurement, expectedEarnings,
  refreshRealFees, readRealFees, attachRealFees } from "../src/realfees.js";
import { makeEnv, call, setNow, restoreNow } from "./helpers.js";

const fixture = JSON.parse(readFileSync(new URL("../../Tests/Fixtures/real_fee_samples.json", import.meta.url), "utf8"));
const t = fixture.end + 86400;
const originalFetch = globalThis.fetch;
afterEach(() => { restoreNow(); globalThis.fetch = originalFetch; });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const measurement = () => calculateMeasurement("Pearl Fortune", [fortuneDays(fixture.fortune, t)], fixture.points, t);

test("independent golden audit: PF hourly hashrate, Kryptex ten-minute and F2 daily work share one chain and five-day window", () => {
  const inputs = [
    ["Pearl Fortune", fortuneDays(fixture.fortune, t), 29.20179850, 30.804792175295702, 5.20371527317508],
    ["Kryptex", kryptexDays(fixture.kChart, fixture.kRewards, t), 34.531810074422815, 36.237751867334154, 4.707636939390625],
    ["F2Pool", f2poolDays(fixture.f2Income, fixture.f2Chart, t), 120.47412850680897, 127.79148111445443, 5.726009702549573],
  ];
  for (const [pool, days, net, expected, cost] of inputs) {
    const o = calculateMeasurement(pool, [days], fixture.points, t);
    near(o.netPRL, net); near(o.expectedPRL, expected); near((1 - o.netPRL / o.expectedPRL) * 100, cost);
    assert.equal(o.start, fixture.start); assert.equal(o.end, fixture.end);
    assert.equal(o.sampleCount, 5); assert.equal(o.theoryBasis, "hashrate_chain");
  }
});

test("missing hashrate, immature income and unbracketed chain history cannot manufacture a new fee", () => {
  const missing = structuredClone(fixture.fortune); missing.data.series.splice(24, 1);
  assert.throws(() => calculateMeasurement("Pearl Fortune", [fortuneDays(missing, t)], fixture.points, t), /no_complete_window/);
  const pending = structuredClone(fixture.kRewards); pending[0].reward = 1;
  assert.throws(() => calculateMeasurement("Kryptex", [kryptexDays(fixture.kChart, pending, t)], fixture.points, t), /no_complete_window/);
  assert.throws(() => calculateMeasurement("Pearl Fortune", [fortuneDays(fixture.fortune, t)], fixture.points.slice(-2), t), /no_complete_window/);
});

test("invalid or pricing-based observations are withheld; negative measured shortfalls survive", () => {
  const good = measurement();
  assert.equal(validMeasurement(good, t), true);
  for (const change of [{ theoryBasis: "pool_pps_pricing" }, { expectedPRL: 0 }, { end: t + 1 }, { sampleCount: 4 }])
    assert.equal(validMeasurement({ ...good, ...change }, t), false);
  setNow(t);
  const lucky = { ...good, netPRL: good.expectedPRL * 1.1 };
  const out = attachRealFees({ rows: [{ name: good.pool, solo: false, payouts: [{ scheme: "PPS", solo: false }, { scheme: "PPLNS", solo: false }] }] }, [lucky]);
  near(out.rows[0].payouts[0].realFeePercent, -10);
  assert.equal(out.rows[0].payouts[1].realFeePercent, null);
});

test("only the latest window counts: one day of settlement lag, never an older five days", () => {
  const good = measurement(), day = 86400;
  // Ends at the previous 00:00 UTC while the pool settles yesterday, until the next 00:00.
  for (const at of [t, t + day - 1]) assert.equal(validMeasurement(good, at), true);
  assert.equal(validMeasurement(good, t + day), false);
  // The data still holds that complete window, but a day later it is history.
  assert.throws(() => calculateMeasurement("Pearl Fortune", [fortuneDays(fixture.fortune, t)], fixture.points, t + day), /no_complete_window/);
  setNow(t + day);
  const row = { name: good.pool, solo: false, payouts: [{ scheme: "PPS", solo: false }] };
  const out = attachRealFees({ rows: [row] }, [good]).rows[0];
  assert.equal(out.payouts[0].realFeePercent, null);
  assert.equal(out.realFeeMeasurement, null);
});

test("idle days count as zero, so the latest five days update daily from whatever was mined", () => {
  const day = 86400, end = fixture.end;
  const chart = (extra) => ({ data: { hashrate_history: { values: [...fixture.f2Chart.data.hashrate_history.values, ...extra] } } });
  // Two days after the sample: one idle, one with a residual 0.886 TH/s and its tiny payout.
  const income = structuredClone(fixture.f2Income);
  income.data.income_data.unshift({ type: "revenue", comment: "With PPS", created_at: end + 2 * day, amount: 0.017 });
  const t2 = end + 2 * day + 3600;
  const days = f2poolDays(income, chart([[end * 1000, 0, "prl"], [(end + day) * 1000, 0.886, "prl"]]), t2);
  const o = calculateMeasurement("F2Pool", [days], fixture.points, t2);
  assert.equal(o.start, end - 3 * day); assert.equal(o.end, end + 2 * day); assert.equal(o.activeDays, 3);
  const mined = days.filter((d) => d.start >= end - 3 * day && d.start < end);
  near(o.netPRL, mined.reduce((s, d) => s + d.net, 0));
  near(o.expectedPRL, mined.reduce((s, d) => s + expectedEarnings(fixture.points, d.intervals[0]), 0));
  assert.equal(validMeasurement(o, t2), true);
  // Yesterday's window still holds the last mined day; once both current windows are idle,
  // there is nothing to measure.
  const idle = [0, 1, 2, 3, 4, 5].map((i) => [(end + i * day) * 1000, 0, "prl"]);
  const at = (t) => calculateMeasurement("F2Pool", [f2poolDays(fixture.f2Income, chart(idle), t)], fixture.points, t);
  assert.equal(at(end + 5 * day + 3600).activeDays, 1);
  assert.throws(() => at(end + 6 * day + 3600), /no_complete_window/);
});

test("Kryptex: a day without a transfer is idle only when nothing was mined", () => {
  const day = 86400, start = fixture.end, t2 = start + day;
  const samples = (rate) => Array.from({ length: 144 }, (_, i) => ({ timestamp: (start + (i + 1) * 600) * 1000, hashrate: rate }));
  const rewards = [{ timestamp: start * 1000, reward: 0, reward_transferred: null }];
  assert.deepEqual(kryptexDays(samples(0), rewards, t2).map((d) => d.net), [0]);
  assert.deepEqual(kryptexDays(samples(1e15), rewards, t2), []); // Mined but unsettled.
  assert.deepEqual(kryptexDays(samples(0), [{ ...rewards[0], reward: 1 }], t2), []);
});

// 100 blocks on chain where the displayed work expected 120: 78.4% after a 2% fee. The pool's
// own list took 120 blocks of work for its 100 (luck 0.833), so luck-free it is 0.784 × 1.2 = 0.9408.
const publicPPLNS = (id, pool, ratio = .9408) => ({ id, pool, scheme: "PPLNS", netPRL: 78.4, expectedPRL: 100, expectedBlocks: 120,
  poolBlocks: 100, orphans: 0, work: 120, luck: 100 / 120, ratio,
  start: t - 5 * 86400, end: t, estimated: true, sampleCount: 1440, blocksSample: 100, theoryBasis: "pool_effort" });

test("PPLNS requires five days of public work; the cost is the luck-free ratio, never the raw block count", () => {
  setNow(t);
  const row = { id: "alpha", name: "AlphaPool", solo: false, theoreticalEarningsPerPH: 100, sampleDays: 1,
    payouts: [{ scheme: "PPLNS", fee: 2, grossPerPH: 80, solo: false }] };
  const estimate = (sample = publicPPLNS(row.id, row.name)) => attachRealFees({ ts: t, rows: [row] }, [], [sample]).rows[0].payouts[0];
  const before = structuredClone(row), p = estimate();
  near(p.realFeePercent, 5.92);
  assert.equal(p.realFeeEstimated, true);
  assert.deepEqual(p.realFeePeriod, { start: t - 5 * 86400, end: t });
  assert.deepEqual(row, before);
  near(estimate(publicPPLNS(row.id, row.name, 1.2)).realFeePercent, -20);
  assert.equal(estimate(publicPPLNS(row.id, row.name, 1)).realFeePercent, 0);
  assert.equal(estimate(publicPPLNS(row.id, row.name, 0)).realFeePercent, 100);
  assert.equal(attachRealFees({ ts: t, rows: [row] }, []).rows[0].payouts[0].realFeePercent, null);
  for (const change of [{ start: t - 86400 }, { start: t - 5 * 86400 + 1 }, { expectedPRL: 0 },
    { netPRL: NaN }, { end: t - 1801 }, { id: "other" }, { pool: "other" }, { theoryBasis: "hashrate_chain" },
    // Written before luck was taken out: block luck included, so never shown.
    { theoryBasis: "public_pool_work" }, { ratio: undefined }, { ratio: NaN }, { ratio: 2.01 }, { poolBlocks: 0 }, { work: 0 },
    { expectedBlocks: 99.9 }, { expectedBlocks: undefined }]) {
    assert.equal(estimate({ ...publicPPLNS(row.id, row.name), ...change }).realFeePercent, null);
  }
});

test("the shared-reward estimate reaches PROP and PearlHash's unnamed payout, not an unnamed payout elsewhere", () => {
  setNow(t);
  const cost = (id, name, scheme) => attachRealFees({ ts: t, rows: [{ id, name, solo: false,
    payouts: [{ scheme, fee: 2, grossPerPH: 80, solo: false }] }] }, [], [publicPPLNS(id, name)]).rows[0].payouts[0];
  near(cost("hero", "HeroMiners", "PROP").realFeePercent, 5.92);
  const pearlhash = cost("https://pearlhash.xyz/", "PearlHash", null);
  near(pearlhash.realFeePercent, 5.92);
  assert.equal(pearlhash.realFeeEstimated, true);
  assert.deepEqual(pearlhash.realFeePeriod, { start: t - 5 * 86400, end: t });
  assert.equal(cost("other", "Other", null).realFeePercent, null);
  assert.equal(cost("https://pearlhash.xyz/", "PearlHash", "PPS").realFeePercent, null);
});

test("Fortune retains the PPS settlement window alongside its five-day PPLNS output estimate", () => {
  setNow(t);
  const observation = measurement();
  const row = { id: "fortune", name: observation.pool, solo: false,
    payouts: [{ scheme: "PPS", fee: 5, grossPerPH: 100, solo: false },
      { scheme: "PPLNS", fee: 2, grossPerPH: 80, solo: false }] };
  const sample = { ...publicPPLNS(row.id, row.name), start: t - 6 * 86400 };
  const out = attachRealFees({ ts: t, rows: [row] }, [observation], [sample]);
  const [pps, pplns] = out.rows[0].payouts;
  near(pps.realFeePercent, 5.20371527317508); near(pplns.realFeePercent, 5.92);
  assert.deepEqual(pps.realFeePeriod, { start: observation.start, end: observation.end });
  assert.deepEqual(pplns.realFeePeriod, { start: sample.start, end: t });
  assert.deepEqual(out.rows[0].realFeeMeasurement, observation);
  const unmeasured = attachRealFees({ ts: t, rows: [row] }, [], [sample]).rows[0];
  assert.equal(unmeasured.payouts[0].realFeePercent, null);
  near(unmeasured.payouts[1].realFeePercent, 5.92);
  assert.equal(unmeasured.realFeeMeasurement, null);
});

test("hourly job is leased across concurrent invocations and public clients never trigger mining-data fetches", async () => {
  setNow(t);
  const target = "prl1" + "a".repeat(60);
  const env = makeEnv({ REAL_FEE_SAMPLES: JSON.stringify([{ pool: "Pearl Fortune", addr: target }]) });
  const insert = env.DB.raw.prepare("INSERT INTO network_samples VALUES (?, ?, ?, ?)");
  for (const p of fixture.points) insert.run(p.height, p.ts, p.difficulty, t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(fixture.fortune); };
  await Promise.all([refreshRealFees(env), refreshRealFees(env), refreshRealFees(env)]);
  assert.equal(calls, 1);
  const observations = await readRealFees(env.DB, t);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].end, fixture.end);
  const reply = await call(env, "GET", "/v1/pool-fees");
  assert.equal(reply.status, 200);
  const body = reply.body;
  assert.equal(body.measurements[0].end, fixture.end);
  assert.ok(!JSON.stringify(body).includes(target));
  assert.equal(calls, 1);
  // The configured sample fails, so the pool's latest block is asked for a replacement; it fails too.
  const urls = [];
  setNow(t + 3600); globalThis.fetch = async (url) => { calls++; urls.push(String(url)); return new Response("bad", { status: 503 }); };
  await refreshRealFees(env);
  assert.deepEqual(urls.map((u) => new URL(u).pathname.split("/").at(-1)), ["hourly-shares", "blocks"]);
  const retained = await readRealFees(env.DB, t + 3600);
  assert.equal(retained[0].end, fixture.end);
  assert.equal(retained[0].measuredAt, t); // Failure never relabels an old sample as newly measured.
  assert.equal(env.DB.rows("SELECT k FROM kv WHERE k='public:realfees:Pearl Fortune'").length, 1);

  // A day later the same replies hold no current window and no replacement is listed: the old
  // one is deleted, not kept.
  setNow(t + 86400 + 3600); globalThis.fetch = async (url) => { calls++; return String(url).includes("/blocks") ? Response.json({ data: { blocks: [] } }) : Response.json(fixture.fortune); };
  await refreshRealFees(env);
  assert.equal(calls, 5);
  assert.equal(env.DB.rows("SELECT k FROM kv WHERE k='public:realfees:Pearl Fortune'").length, 0);
  assert.deepEqual((await call(env, "GET", "/v1/pool-fees")).body.measurements, []);
});

test("a malformed stored value is deleted after a failed refresh", async () => {
  setNow(t);
  const env = makeEnv({ REAL_FEE_SAMPLES: JSON.stringify([{ pool: "Pearl Fortune", addr: "prl1" + "a".repeat(60) }]) });
  env.DB.raw.prepare("INSERT INTO kv (k,v,ts) VALUES (?,?,?)").run("public:realfees:Pearl Fortune", "{", t);
  globalThis.fetch = async () => new Response("bad", { status: 503 });
  await refreshRealFees(env);
  assert.equal(env.DB.rows("SELECT k FROM kv WHERE k='public:realfees:Pearl Fortune'").length, 0);
});

// A configured sample that mined nothing: complete hours with zero work and no PPS income.
const idleFortune = () => {
  const o = structuredClone(fixture.fortune), data = o.data || o;
  for (const p of data.series) Object.assign(p.share_statistics, { effective_hashrate: 0, accepted_work_sum: 0 });
  data.pps_income.hourly = [];
  return o;
};
const withChain = (env) => {
  const insert = env.DB.raw.prepare("INSERT INTO network_samples VALUES (?, ?, ?, ?)");
  for (const p of fixture.points) insert.run(p.height, p.ts, p.difficulty, t);
  return env;
};

test("an idle sample is replaced by a miner from the latest block's share snapshot, which is remembered", async () => {
  setNow(t);
  const configured = "prl1" + "a".repeat(60), pplns = "prl1" + "b".repeat(60), active = "prl1" + "c".repeat(60);
  const env = withChain(makeEnv({ REAL_FEE_SAMPLES: JSON.stringify([{ pool: "Pearl Fortune", addr: configured }]) }));
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    // The block list masks finders; the block's share snapshot names contributors in full.
    if (u.pathname.endsWith("/blocks")) { asked.push("blocks"); return Response.json({ data: { blocks: [{ block_hash: "e".repeat(64), miner_address: "prl1pfmjjv...5stkkvsw" }] } }); }
    if (u.pathname.endsWith("/blocks/" + "e".repeat(64))) {
      asked.push("block");
      const shares = { [active]: 10, [configured]: 99, junk: 50, [pplns]: 20, ["prl1" + "d".repeat(60)]: 1 };
      return Response.json({ data: { extra_data: JSON.stringify({ pearl_payment_snapshot: { shares_by_address: shares } }) } });
    }
    const who = decodeURIComponent(u.pathname.split("/")[4]);
    asked.push(who === configured ? "configured" : who === pplns ? "pplns" : who === active ? "active" : who);
    if (who === configured) return Response.json(idleFortune());
    // A PPLNS miner works but has no PPS income, so its days never validate.
    if (who === pplns) { const o = structuredClone(fixture.fortune); (o.data || o).pps_income.hourly = []; return Response.json(o); }
    return Response.json(fixture.fortune);
  };
  await refreshRealFees(env);
  // Largest contributors first, skipping the configured sample and anything invalid.
  assert.deepEqual(asked, ["configured", "blocks", "block", "pplns", "active"]);
  const [o] = await readRealFees(env.DB, t);
  assert.equal(o.activeDays, 5); assert.equal(o.end, fixture.end);
  near(o.netPRL, measurement().netPRL);
  assert.equal(env.DB.one("SELECT v FROM kv WHERE k='realfees:auto:Pearl Fortune'").v, active);
  const reply = await call(env, "GET", "/v1/pool-fees");
  for (const a of [configured, pplns, active]) assert.ok(!JSON.stringify(reply.body).includes(a));

  // Next hour the remembered miner is asked directly; the block list is not.
  asked.length = 0; setNow(t + 3600);
  await refreshRealFees(env);
  assert.deepEqual(asked, ["configured", "active"]);
});

test("a configured sample that mined all five days asks nothing else; Kryptex candidates must be PPS", async () => {
  setNow(t);
  const env = withChain(makeEnv({ REAL_FEE_SAMPLES: JSON.stringify([{ pool: "Pearl Fortune", addr: "prl1" + "a".repeat(60) }, { pool: "Kryptex", addr: "prl1" + "k".repeat(60) }]) }));
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url); asked.push(u.replace(/prl1([a-z])\1+/, (m) => m.slice(0, 5)));
    if (u.includes("pearlfortune")) return Response.json(fixture.fortune);
    if (u.endsWith("/pool/blocks")) return Response.json({ results: [{ miner: "prl1" + "p".repeat(60), scheme: "pplns" }, { miner: "prl1" + "s".repeat(60), scheme: "pps" }] });
    return new Response("bad", { status: 503 });
  };
  await refreshRealFees(env);
  assert.equal(asked.filter((u) => u.includes("pearlfortune")).length, 1);
  const kryptex = asked.filter((u) => u.includes("kryptex"));
  assert.ok(kryptex.some((u) => u.includes("/prl1s")));
  assert.ok(!kryptex.some((u) => u.includes("/prl1p")));
});
