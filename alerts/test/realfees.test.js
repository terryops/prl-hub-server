import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fortuneDays, kryptexDays, f2poolDays, calculateMeasurement, validMeasurement,
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

const publicPPLNS = (id, pool, netPRL = 78.4) => ({ id, pool, scheme: "PPLNS", netPRL, expectedPRL: 100,
  start: t - 5 * 86400, end: t, estimated: true, sampleCount: 1440, blocksSample: 40, theoryBasis: "public_pool_work" });

test("PPLNS requires five days of public work; its fee-adjusted total is never charged twice", () => {
  setNow(t);
  const row = { id: "alpha", name: "AlphaPool", solo: false, theoreticalEarningsPerPH: 100, sampleDays: 1,
    payouts: [{ scheme: "PPLNS", fee: 2, grossPerPH: 80, solo: false }] };
  const estimate = (sample = publicPPLNS(row.id, row.name)) => attachRealFees({ ts: t, rows: [row] }, [], [sample]).rows[0].payouts[0];
  const before = structuredClone(row), p = estimate();
  near(p.realFeePercent, 21.6);
  assert.equal(p.realFeeEstimated, true);
  assert.deepEqual(p.realFeePeriod, { start: t - 5 * 86400, end: t });
  assert.deepEqual(row, before);
  near(estimate(publicPPLNS(row.id, row.name, 120)).realFeePercent, -20);
  assert.equal(estimate(publicPPLNS(row.id, row.name, 100)).realFeePercent, 0);
  assert.equal(estimate(publicPPLNS(row.id, row.name, 0)).realFeePercent, 100);
  assert.equal(attachRealFees({ ts: t, rows: [row] }, []).rows[0].payouts[0].realFeePercent, null);
  for (const change of [{ start: t - 86400 }, { start: t - 5 * 86400 + 1 }, { expectedPRL: 0 },
    { netPRL: NaN }, { end: t - 1801 }, { id: "other" }, { pool: "other" }, { theoryBasis: "hashrate_chain" }]) {
    assert.equal(estimate({ ...publicPPLNS(row.id, row.name), ...change }).realFeePercent, null);
  }
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
  near(pps.realFeePercent, 5.20371527317508); near(pplns.realFeePercent, 21.6);
  assert.deepEqual(pps.realFeePeriod, { start: observation.start, end: observation.end });
  assert.deepEqual(pplns.realFeePeriod, { start: sample.start, end: t });
  assert.deepEqual(out.rows[0].realFeeMeasurement, observation);
  const unmeasured = attachRealFees({ ts: t, rows: [row] }, [], [sample]).rows[0];
  assert.equal(unmeasured.payouts[0].realFeePercent, null);
  near(unmeasured.payouts[1].realFeePercent, 21.6);
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
  setNow(t + 3600); globalThis.fetch = async () => { calls++; return new Response("bad", { status: 503 }); };
  await refreshRealFees(env);
  const retained = await readRealFees(env.DB, t + 3600);
  assert.equal(retained[0].end, fixture.end);
  assert.equal(retained[0].measuredAt, t); // Failure never relabels an old sample as newly measured.
});
