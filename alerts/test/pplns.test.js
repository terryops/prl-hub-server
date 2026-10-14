import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pplnsPoint, extendPPLNSHistory, pplnsMeasurement, recordPPLNSSnapshot, readPPLNSMeasurements } from "../src/pplns.js";
import { makeEnv, setNow, restoreNow, T0, call, installFetch, tick } from "./helpers.js";

afterEach(restoreNow);
const DAY = 86400;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const point = (ts, changes = {}) => ({ ts, hashPH: 1, unit: 100, reward: 1, fee: 2, blocks: 1000 + Math.floor((ts - T0) / 1080), ...changes });
const history = (days, changes = {}) => {
  let value;
  for (let dt = 0; dt <= days * DAY; dt += 300) value = extendPPLNSHistory(value, "alpha", "AlphaPool", point(T0 + dt, changes));
  return value;
};
const row = { id: "alpha", name: "AlphaPool", solo: false, hashrate: 1e15, lifetimeBlocks: 1000,
  payouts: [{ scheme: "PPLNS", solo: false, fee: 2, grossPerPH: 80, realFeePercent: null }] };
const snapshot = (ts = T0, changes = {}) => ({ ok: true, schemaVersion: 1, ts, stale: false, partial: false,
  rows: [row], network: { ts, prlPerTHDay: .1, reward: 1 }, ...changes });

test("PPLNS: a complete five-day window is required; pool work and rewards are aggregated, not percentages", () => {
  const h = history(5), end = T0 + 5 * DAY, value = pplnsMeasurement(h, end);
  assert.equal(pplnsMeasurement(history(4), T0 + 4 * DAY), null);
  assert.equal(pplnsMeasurement(history(5 - 300 / DAY), end), null);
  assert.equal(value.start, T0); assert.equal(value.end, end);
  near(value.expectedPRL, 500); near(value.netPRL, 392);
  near((1 - value.netPRL / value.expectedPRL) * 100, 21.6);
  assert.equal(value.sampleCount, 1440); assert.equal(value.blocksSample, 400);
  assert.ok(h.segments.length <= 121); // Bounded hourly buckets rather than thousands of stored samples.
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

test("PPLNS: missing coverage and counter resets restart the window; corrupt histories cannot establish coverage", () => {
  const h = history(5), end = h.last.ts;
  for (const p of [point(end + 901), point(end + 300, { blocks: 0 })]) {
    const next = extendPPLNSHistory(h, "alpha", "AlphaPool", p);
    assert.equal(next.segments.length, 0);
    assert.equal(pplnsMeasurement(next, p.ts), null);
  }
  const gap = structuredClone(h); gap.segments[2].start++;
  assert.equal(pplnsMeasurement(gap, end), null);
  const negative = structuredClone(h); negative.segments[0].netPRL = -1;
  assert.equal(pplnsMeasurement(negative, end), null);
  assert.equal(pplnsMeasurement(h, end + 1801), null);
  assert.equal(pplnsMeasurement(h, end - 61), null);
});

test("PPLNS: negative real cost and genuinely zero output survive; idle work cannot invent theory", () => {
  const end = T0 + 5 * DAY;
  const zero = history(5, { blocks: 1000 });
  assert.equal(pplnsMeasurement(zero, end).netPRL, 0);
  near((1 - pplnsMeasurement(zero, end).netPRL / pplnsMeasurement(zero, end).expectedPRL) * 100, 100);
  const lucky = history(5, { reward: 2, fee: 0 });
  near((1 - pplnsMeasurement(lucky, end).netPRL / pplnsMeasurement(lucky, end).expectedPRL) * 100, -60);
  assert.equal(pplnsMeasurement(history(5, { hashPH: 0 }), end), null);
  const kept = history(12), value = pplnsMeasurement(kept, T0 + 12 * DAY);
  assert.ok(value.end - value.start >= 5 * DAY && value.end - value.start <= 7 * DAY + 3600);
  assert.ok(kept.segments.length <= 169);
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
  await recordPPLNSSnapshot(env.DB, snapshot());
  await recordPPLNSSnapshot(env.DB, snapshot());
  assert.deepEqual(await readPPLNSMeasurements(env.DB, [row]), []);
  const end = T0 + 5 * DAY; setNow(end);
  await env.DB.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind("public:pplns:alpha", JSON.stringify(history(5)), end).run();
  const saved = snapshot(end);
  await env.DB.prepare("INSERT INTO kv(k,v,ts) VALUES(?,?,?)").bind("public:overview:v1", JSON.stringify(saved), end).run();
  const response = await call(env, "GET", "/v1/pools");
  assert.equal(response.status, 200);
  near(response.body.rows[0].payouts[0].realFeePercent, 21.6);
  assert.deepEqual(response.body.rows[0].payouts[0].realFeePeriod, { start: T0, end });
  assert.ok(!JSON.stringify(response.body).includes("segments"));
  assert.equal(env.DB.rows("SELECT * FROM groups").length, 0);
  const before = env.DB.one("SELECT v FROM kv WHERE k='public:pplns:alpha'").v;
  await recordPPLNSSnapshot(env.DB, { ...saved, stale: true });
  assert.equal(env.DB.one("SELECT v FROM kv WHERE k='public:pplns:alpha'").v, before);
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
  assert.equal(net.overviewRequests.length, 6); // MPS data needs a successful page first.
  const first = env.DB.one("SELECT v FROM kv WHERE k LIKE 'public:pplns:%'");
  assert.ok(first); assert.equal(JSON.parse(first.v).segments.length, 0);
  setNow(T0 + 60); await tick(env);
  assert.equal(net.overviewRequests.length, 6);
  setNow(T0 + 300); await tick(env);
  assert.equal(net.overviewRequests.length, 12);
  const next = JSON.parse(env.DB.one("SELECT v FROM kv WHERE k LIKE 'public:pplns:%'").v);
  assert.equal(next.segments.length, 1); assert.equal(next.segments[0].blocks, 1);
  assert.equal(env.DB.rows("SELECT * FROM groups").length, 0);
});
