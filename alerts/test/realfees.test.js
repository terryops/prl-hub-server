import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fortuneDays, kryptexDays, f2poolDays, calculateMeasurement, validMeasurement, expectedEarnings,
  refreshRealFees, readRealFees, attachRealFees, perynAddress, perynPayees, perynMeasurement } from "../src/realfees.js";
import { makeEnv, call, setNow, restoreNow } from "./helpers.js";

const fixture = JSON.parse(readFileSync(new URL("../../Tests/Fixtures/real_fee_samples.json", import.meta.url), "utf8"));
const t = fixture.end + 86400;
const originalFetch = globalThis.fetch;
afterEach(() => { restoreNow(); globalThis.fetch = originalFetch; });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const measurement = () => calculateMeasurement("Pearl Fortune", [fortuneDays(fixture.fortune, t)], fixture.points, t);
// Peryn is read once a day from 00:30 UTC; tests of the other pools mark that day as done.
const perynRead = (env, at) => env.DB.raw.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)")
  .run("realfees:last-success:Peryn", String(Math.floor(at / 86400) * 86400), at);

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
  near(cost("hero", "HeroMiners", "PROP").realFeePercent, 100 - (100 - 5.92) * .955);
  // PearlHash's and HeroMiners' figures also count the shares they never turn into blocks (see the next test).
  const pearlhash = cost("https://pearlhash.xyz/", "PearlHash", null);
  near(pearlhash.realFeePercent, 100 - (100 - 5.92) * .915);
  assert.equal(pearlhash.realFeeEstimated, true);
  assert.deepEqual(pearlhash.realFeePeriod, { start: t - 5 * 86400, end: t });
  assert.equal(cost("other", "Other", null).realFeePercent, null);
  assert.equal(cost("https://pearlhash.xyz/", "PearlHash", "PPS").realFeePercent, null);
});

test("PearlHash's and HeroMiners' Real Cost count the shares they never turn into blocks: 100 − the rest × yield", () => {
  setNow(t);
  const out = (rows, samples) => attachRealFees({ ts: t, rows }, [], samples).rows;
  const row = (id, name, solo = false) => ({ id, name, solo, payouts: [{ scheme: solo ? "SOLO" : "PROP", fee: 1, grossPerPH: 80, solo }] });
  const PH = "https://pearlhash.xyz/";
  const [ph, phSolo, hero] = out([row(PH, "PearlHash"), row(PH + "solo", "PearlHash SOLO", true), row("hero", "HeroMiners")],
    [publicPPLNS(PH, "PearlHash", .99), publicPPLNS("hero", "HeroMiners", .99)]);
  const p = ph.payouts[0];
  near(p.realFeePercent, 100 - 99 * .915);
  assert.equal(p.shareYield, .915);
  assert.equal(p.realFeeEstimated, true);
  // HeroMiners with its own yield; not a solo payout, not another pool; and no old fields.
  assert.equal(phSolo.payouts[0].shareYield, undefined);
  assert.equal(hero.payouts[0].shareYield, .955); near(hero.payouts[0].realFeePercent, 100 - 99 * .955);
  const [other] = out([row("other", "Other")], [publicPPLNS("other", "Other", .99)]);
  assert.equal(other.payouts[0].shareYield, undefined);
  for (const k of ["minerReport", "realFeePending"]) assert.equal(p[k], undefined, k);
  // No Real Cost yet: no figure and no bubble.
  const none = out([row(PH, "PearlHash")], [])[0].payouts[0];
  assert.equal(none.realFeePercent, null); assert.equal(none.shareYield, undefined);
  // A second request applies the same constant once, not again.
  near(out([row(PH, "PearlHash")], [publicPPLNS(PH, "PearlHash", .5)])[0].payouts[0].realFeePercent, 100 - 50 * .915);
  near(out([row(PH, "PearlHash")], [publicPPLNS(PH, "PearlHash", .99)])[0].payouts[0].realFeePercent, 100 - 99 * .915);
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
  setNow(t + 3600); perynRead(env, t + 3600); globalThis.fetch = async (url) => { calls++; urls.push(String(url)); return new Response("bad", { status: 503 }); };
  await refreshRealFees(env);
  assert.deepEqual(urls.map((u) => new URL(u).pathname.split("/").at(-1)), ["hourly-shares", "blocks"]);
  const retained = await readRealFees(env.DB, t + 3600);
  assert.equal(retained[0].end, fixture.end);
  assert.equal(retained[0].measuredAt, t); // Failure never relabels an old sample as newly measured.
  assert.equal(env.DB.rows("SELECT k FROM kv WHERE k='public:realfees:Pearl Fortune'").length, 1);

  // A day later the same replies hold no current window and no replacement is listed: the old
  // one is deleted, not kept.
  setNow(t + 86400 + 3600); perynRead(env, t + 86400 + 3600); globalThis.fetch = async (url) => { calls++; return String(url).includes("/blocks") ? Response.json({ data: { blocks: [] } }) : Response.json(fixture.fortune); };
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
  asked.length = 0; setNow(t + 3600); perynRead(env, t + 3600);
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

// ── Peryn ──────────────────────────────────────────────────────────────────────────────────────────────
// Its address dashboard as served on 2026-11-03, cut to what is read: the fee card, the payout mode, a worker's mode
// cell, the per-day hashrate and credited $PEARL (the same titles as its charts).
const DAY = 86400;
const label = (s) => { const d = new Date(s * 1000); return `${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })}`; };
const perynPage = ({ fee = "1% fee", payout = "PPS+ · paid every 2 hours", modes = ["PPS+"], hashrate = [], credit = [] }) =>
  `<html><body><h1 id="address-title">Mining dashboard</h1><section data-fee=""><p class="text-text">PPLNS · 1% fee</p>` +
  `<p class="text-text">PPS+ · ${fee}</p></section><span class="text-sm" data-payout-mode="">${payout}</span>` +
  hashrate.map(([s, v]) => `<g><title>${label(s)}: ${v}</title></g>`).join("") +
  credit.map(([s, p, a]) => `<g><title>${label(s)}: predicted ${p} $PEARL, actual ${a} $PEARL</title></g>`).join("") +
  `<table>${modes.map((m) => `<tr><td class="px-4 py-4 hidden lg:table-cell text-xs">${m}</td></tr>`).join("")}</table></body></html>`;
// An address that mined `rate` H/s from the day before the window through its end, credited (1 − cost) of the chain
// integral; Peryn predicts ours × `predict`.
const perynMiner = (rate, cost, { from = fixture.start - DAY, predict = 1, skip = [] } = {}) => {
  const hashrate = [], credit = [];
  for (let s = from; s < fixture.end; s += DAY) {
    if (skip.includes(s)) continue;
    const e = s >= fixture.start ? expectedEarnings(fixture.points, { start: s, end: s + DAY, hashrate: rate }) : 10;
    hashrate.push([s, `${(rate / 1e15).toFixed(2)} PH/s`]);
    credit.push([s, (e * predict).toFixed(2), (e * (1 - cost / 100)).toFixed(2)]);
  }
  return { hashrate, credit };
};
const perynAt = fixture.end + 1800; // half an hour after the window's last 00:00 UTC
const PH = 1e15;

test("Peryn: an address page gives its fee tier and days; a PPLNS worker, a PPLNS payout or no fee card leaves it out", () => {
  const days = perynMiner(5 * PH, 0.5);
  const founding = perynAddress(perynPage({ fee: "0.5% fee (Founding Miner)", ...days }), perynAt);
  assert.equal(founding.tier, "founding");
  assert.equal(founding.days.length, 6);
  assert.equal(founding.days[0].start, fixture.start - DAY);
  assert.equal(founding.days[1].hashrate, 5 * PH);
  assert.equal(perynAddress(perynPage({ ...days }), perynAt).tier, "standard");
  // Thousands separators and other units.
  const big = perynAddress(perynPage({ hashrate: [[fixture.start, "980 TH/s"]], credit: [[fixture.start, "1,234.56", "1,222.21"]] }), perynAt);
  assert.deepEqual(big.days, [{ start: fixture.start, predicted: 1234.56, actual: 1222.21, hashrate: 980e12 }]);
  for (const page of [perynPage({ modes: ["PPS+", "PPLNS"], ...days }), perynPage({ payout: "PPLNS · paid from blocks", ...days }),
    perynPage({ ...days }).replace(/<p class="text-text">PPS\+[^<]*<\/p>/, "")])
    assert.equal(perynAddress(page, perynAt), null);
  // A day listed twice is not read at all.
  const twice = perynAddress(perynPage({ credit: [[fixture.start, "1", "1"], [fixture.start, "2", "2"], [fixture.start + DAY, "3", "3"]] }), perynAt);
  assert.deepEqual(twice.days.map((d) => d.start), [fixture.start + DAY]);
  // "30 Sep" read in early January is last year's.
  const january = Date.UTC(2027, 0, 2) / 1000;
  assert.equal(perynAddress(perynPage({ credit: [[fixture.start, "1", "1"]] }), january).days[0].start, fixture.start);
});

test("Peryn: each tier counts its own addresses, without first days or days Peryn predicted differently", () => {
  const page = (fee, days) => perynAddress(perynPage({ fee, ...days }), perynAt);
  const f = "0.5% fee (Founding Miner)";
  const addresses = [
    page(f, perynMiner(8 * PH, 0.7)),
    // Starts inside the window: its first day is left out, the rest count.
    page(f, perynMiner(2 * PH, 0.9, { from: fixture.start + DAY })),
    page("1% fee", perynMiner(20 * PH, 1.25)),
    // Peryn predicted 10% more than the chain gives: work that was not PPS+, never a fee.
    page("1% fee", perynMiner(4 * PH, 30, { predict: 1.1 })),
  ];
  const founding = perynMeasurement("founding", addresses, fixture.points, perynAt);
  const standard = perynMeasurement("standard", addresses, fixture.points, perynAt);
  assert.equal(founding.start, fixture.start); assert.equal(founding.end, fixture.end);
  assert.equal(founding.addresses, 2); assert.equal(founding.activeDays, 5);
  assert.equal(standard.addresses, 1);
  // 8 PH/s at 0.7% all five days, 2 PH/s at 0.9% on the last three.
  const e = (rate, from) => { let x = 0; for (let s = from; s < fixture.end; s += DAY) x += expectedEarnings(fixture.points, { start: s, end: s + DAY, hashrate: rate }); return x; };
  const want = (e(8 * PH, fixture.start) * 0.7 + e(2 * PH, fixture.start + 2 * DAY) * 0.9) / (e(8 * PH, fixture.start) + e(2 * PH, fixture.start + 2 * DAY));
  assert.ok(Math.abs((1 - founding.netPRL / founding.expectedPRL) * 100 - want) < 0.01);
  assert.ok(Math.abs((1 - standard.netPRL / standard.expectedPRL) * 100 - 1.25) < 0.01);
  assert.equal(validMeasurement(founding, perynAt), true);
  // Fewer than three days in the window is no figure.
  const short = [page("1% fee", perynMiner(20 * PH, 1, { from: fixture.end - 3 * DAY }))];
  assert.throws(() => perynMeasurement("standard", short, fixture.points, perynAt), /no_complete_window/);
  // Payees: largest first, never the pool's own inputs.
  const pool = "prl1" + "p".repeat(60), a = "prl1" + "a".repeat(60), b = "prl1" + "b".repeat(60);
  const tx = (vin, vout) => ({ vin: vin.map((x) => ({ addresses: [x] })), vout: vout.map(([x, v]) => ({ addresses: [x], value: String(v) })) });
  assert.deepEqual(perynPayees([tx([pool], [[a, 100], [pool, 9e9], [b, 300]]), tx([pool], [[a, 250], ["junk", 1e9]])]), [a, b]);
});

test("Peryn: read once a day from 00:30 UTC from its payout batches; addresses never reach public JSON", async () => {
  const env = withChain(makeEnv());
  const pool = "prl1" + "p".repeat(60), founder = "prl1" + "f".repeat(60), other = "prl1" + "s".repeat(60), mixed = "prl1" + "m".repeat(60);
  const pages = {
    [founder]: perynPage({ fee: "0.5% fee (Founding Miner)", ...perynMiner(6 * PH, 0.8) }),
    [other]: perynPage({ fee: "1% fee", ...perynMiner(3 * PH, 1.3) }),
    [mixed]: perynPage({ modes: ["PPLNS"], ...perynMiner(9 * PH, 50) }),
  };
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url); asked.push(u.pathname.replace(/prl1([a-z])\1+/, (m) => m.slice(0, 5)));
    if (u.pathname === "/api/v1/payments") return Response.json({ v: 1, payments: [{ txids: ["a".repeat(64)] }, { txids: ["b".repeat(64), "bad"] }] });
    if (u.pathname.startsWith("/api/v2/tx/")) return Response.json({ vin: [{ addresses: [pool] }],
      vout: [[pool, 9e10], [founder, 6e8], [other, 3e8], [mixed, 1e8]].map(([a, v]) => ({ addresses: [a], value: String(v) })) });
    if (u.pathname.startsWith("/address/")) return new Response(pages[u.pathname.slice(9)]);
    return new Response("bad", { status: 503 });
  };
  // Before 00:30 the day is still being credited: nothing is asked.
  setNow(fixture.end + 1799); await refreshRealFees(env);
  assert.deepEqual(asked, []);
  setNow(perynAt); await refreshRealFees(env);
  assert.deepEqual(asked, ["/api/v1/payments", "/api/v2/tx/" + "a".repeat(64), "/api/v2/tx/" + "b".repeat(64),
    "/address/prl1f", "/address/prl1s", "/address/prl1m"]);
  const ms = await readRealFees(env.DB, perynAt);
  const by = Object.fromEntries(ms.map((o) => [o.tier, o]));
  assert.ok(Math.abs((1 - by.founding.netPRL / by.founding.expectedPRL) * 100 - 0.8) < 0.01);
  assert.ok(Math.abs((1 - by.standard.netPRL / by.standard.expectedPRL) * 100 - 1.3) < 0.01);
  const reply = await call(env, "GET", "/v1/pool-fees");
  assert.equal(reply.body.measurements.length, 2);
  for (const a of [pool, founder, other, mixed]) assert.ok(!JSON.stringify(reply.body).includes(a));
  // Done for the day: later runs ask nothing, even with the lease free.
  asked.length = 0; setNow(perynAt + 2 * 3600); await refreshRealFees(env);
  assert.deepEqual(asked, []);
  // The next day Peryn is down: nothing is written, yesterday's figures stay while current, and the next hour tries again.
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response("bad", { status: 503 }); };
  setNow(perynAt + DAY); await refreshRealFees(env);
  assert.equal(asked.length, 1);
  assert.equal((await readRealFees(env.DB, perynAt + DAY)).length, 2);
  setNow(perynAt + DAY + 1800); await refreshRealFees(env);
  assert.equal(asked.length, 1); // leased for the hour
  setNow(perynAt + DAY + 3600); await refreshRealFees(env);
  assert.equal(asked.length, 2);
  // Two days on, they are history and deleted.
  setNow(perynAt + 2 * DAY); await refreshRealFees(env);
  assert.equal(env.DB.rows("SELECT k FROM kv WHERE k LIKE 'public:realfees:Peryn:%'").length, 0);
});

test("Peryn: the Founding Miners' figure leads while sign-ups are open, everyone else's once they close", () => {
  setNow(perynAt);
  const base = { pool: "Peryn", scheme: "PPS+", start: fixture.start, end: fixture.end, measuredAt: perynAt, estimated: true,
    sampleCount: 5, activeDays: 5, addresses: 3, theoryBasis: "hashrate_chain" };
  const founding = { ...base, tier: "founding", netPRL: 99.2, expectedPRL: 100 }, standard = { ...base, tier: "standard", netPRL: 98.7, expectedPRL: 100 };
  const row = (open) => ({ name: "Peryn", solo: false, payouts: [
    { scheme: "PPLNS", solo: false, ...(open ? { founding: { fee: 0, afterFP8Months: 6 } } : {}) },
    { scheme: "PPS+", solo: false, ...(open ? { founding: { fee: 0.5 } } : {}) }] });
  const [pplns, open] = attachRealFees({ rows: [row(true)] }, [standard, founding]).rows[0].payouts;
  near(open.realFeePercent, 0.8); assert.equal(open.realFeeTier, "founding");
  near(open.realFeeTiers.founding, 0.8); near(open.realFeeTiers.standard, 1.3);
  assert.deepEqual(open.realFeePeriod, { start: fixture.start, end: fixture.end });
  assert.equal(pplns.realFeePercent, null); assert.equal(pplns.realFeeTier, undefined);
  const closed = attachRealFees({ rows: [row(false)] }, [founding, standard]).rows[0];
  near(closed.payouts[1].realFeePercent, 1.3); assert.equal(closed.payouts[1].realFeeTier, "standard");
  assert.equal(closed.realFeeMeasurement.tier, "standard");
  // Only one tier measured: that one, named, with the other missing.
  const only = attachRealFees({ rows: [row(true)] }, [standard]).rows[0].payouts[1];
  near(only.realFeePercent, 1.3); assert.equal(only.realFeeTier, "standard"); assert.equal(only.realFeeTiers.founding, null);
  // A tier needs three days, and a tier is Peryn's alone.
  assert.equal(validMeasurement({ ...founding, activeDays: 2 }, perynAt), false);
  assert.equal(validMeasurement({ ...founding, pool: "Kryptex" }, perynAt), false);
  assert.equal(validMeasurement({ ...founding, tier: "gold" }, perynAt), false);
});
