// Server-owned PPS measurements and public PPLNS output estimates. Sampling credentials stay in a
// Worker secret; neither addresses nor read-only capabilities enter public JSON.
import { readCapped, MAX_BODY, UA, SOURCES, sanitizeTarget } from "./pools.js";
import { reserveBudget } from "./poolstats.js";
import { now, webJson as json } from "./http.js";
import { validPPLNSMeasurement } from "./pplns.js";

const DAY = 86400, DAYS = 5, WORK = 2 ** 48, EMISSION = 650226n;
const POOLS = { "Pearl Fortune": "PPS", Kryptex: "PPS+", F2Pool: "PPS" };
const key = (pool) => `public:realfees:${pool}`;
const number = (v) => (typeof v === "number" || typeof v === "string") && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const unwrap = (v) => v?.data || v;

export function validMeasurement(o, t = now()) {
  return !!o && POOLS[o.pool] === o.scheme && o.theoryBasis === "hashrate_chain" &&
    Number.isFinite(o.netPRL) && o.netPRL >= 0 && Number.isFinite(o.expectedPRL) && o.expectedPRL > 0 &&
    Number.isSafeInteger(o.start) && o.start > 0 && Number.isSafeInteger(o.end) &&
    o.end - o.start === DAYS * DAY && o.start % DAY === 0 && o.end <= t && o.end > t - 31 * DAY &&
    Number.isFinite(o.measuredAt) && o.measuredAt >= o.end && o.measuredAt <= t + 60 &&
    o.sampleCount === DAYS && typeof o.estimated === "boolean";
}

export async function readRealFees(db, t = now()) {
  const { results } = await db.prepare("SELECT v FROM kv WHERE k IN (?, ?, ?)")
    .bind(...Object.keys(POOLS).map(key)).all();
  return results.flatMap(({ v }) => {
    try { const o = JSON.parse(v); return validMeasurement(o, t) ? [o] : []; }
    catch { return []; }
  });
}

export async function realFees(env) {
  const measurements = await readRealFees(env.DB);
  return json({ ok: true, days: DAYS, measurements });
}

function pplnsEstimate(row, payout, measurements) {
  if (row.solo || payout.solo || payout.scheme?.trim().toUpperCase() !== "PPLNS") return null;
  const sample = measurements.find((o) => o.id === row.id && o.pool === row.name && validPPLNSMeasurement(o));
  return sample ? { percent: (1 - sample.netPRL / sample.expectedPRL) * 100, start: sample.start, end: sample.end } : null;
}

export function attachRealFees(snapshot, measurements, pplnsMeasurements = []) {
  return { ...snapshot, rows: snapshot.rows.map((row) => {
    const observation = measurements.find((o) => o.pool === row.name && validMeasurement(o));
    const matches = !row.solo && observation && (row.payouts || []).some((p) => !p.solo && p.scheme === observation.scheme);
    return { ...row, realFeeMeasurement: matches ? observation : null,
      payouts: row.payouts?.map((p) => {
        const measured = matches && !p.solo && p.scheme === observation.scheme;
        const estimate = pplnsEstimate(row, p, pplnsMeasurements);
        return { ...p,
          realFeePercent: measured ? (1 - observation.netPRL / observation.expectedPRL) * 100 : estimate?.percent ?? null,
          realFeeEstimated: measured ? observation.estimated : estimate ? true : null,
          realFeePeriod: measured ? { start: observation.start, end: observation.end }
            : estimate ? { start: estimate.start, end: estimate.end } : null,
        };
      }) };
  }) };
}

// Same consensus subsidy and hashrate integral as the independently checked audit.
export function chainRate(points, t) {
  if (points.length < 2 || t < points[0].ts || t > points.at(-1).ts) throw new Error("chain_coverage");
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].ts <= t) lo = m; else hi = m; }
  const a = points[lo], b = points[hi], f = (t - a.ts) / (b.ts - a.ts);
  const difficulty = a.difficulty + (b.difficulty - a.difficulty) * f;
  const height = BigInt(Math.floor(a.height + (b.height - a.height) * f));
  if (!(difficulty > 0) || height < 1n) throw new Error("chain_data");
  const grains = 2100000000n * 100000000n * EMISSION / ((height + EMISSION) * (height - 1n + EMISSION));
  return Number(grains) / 1e8 / (difficulty * WORK);
}
export function expectedEarnings(points, interval) {
  const { start, end, hashrate } = interval;
  if (!Number.isFinite(hashrate) || hashrate < 0 || end <= start) throw new Error("hashrate_data");
  const steps = Math.ceil((end - start) / 300), dt = (end - start) / steps;
  let total = 0;
  for (let i = 0; i < steps; i++) total += chainRate(points, start + (i + .5) * dt) * hashrate * dt;
  return total;
}

export function fortuneDays(raw, t = now()) {
  const o = unwrap(raw), hours = new Map(), income = new Map();
  for (const p of o?.pps_income?.hourly || []) {
    if (!Number.isSafeInteger(p.hour) || p.hour % 3600) continue;
    try { income.set(p.hour, { mature: BigInt(p.matured_q64), immature: BigInt(p.immature_q64) }); } catch {}
  }
  for (const p of o?.series || []) {
    const h = p?.hour, s = p?.share_statistics, rate = number(s?.effective_hashrate), work = number(s?.accepted_work_sum);
    if (!Number.isSafeInteger(h) || h % 3600 || !s || s.from !== h || s.to !== h + 3600 ||
        !(s.observed_ms > 0 && s.observed_ms <= 3600000) || rate == null || rate < 0 || work == null || work < 0 ||
        number(s.dropped_events) !== 0 || Math.abs(rate * s.observed_ms / 1000 - work) > Math.max(1, work * 1e-12) || hours.has(h)) {
      if (Number.isSafeInteger(h)) hours.set(h, null);
      continue;
    }
    hours.set(h, { start: h, end: h + 3600, hashrate: rate });
  }
  const days = [];
  for (const start of new Set([...hours.keys()].map((h) => Math.floor(h / DAY) * DAY))) {
    if (start + DAY > t) continue;
    const intervals = []; let net = 0n, valid = true;
    for (let h = start; h < start + DAY; h += 3600) {
      const work = hours.get(h), paid = income.get(h);
      if (!work || (work.hashrate > 0 && !paid) || (paid && (paid.immature !== 0n || paid.mature < 0n))) { valid = false; break; }
      intervals.push(work); net += paid?.mature || 0n;
    }
    // matured_q64 is settled net PPS income, not its quoted gross price. Its
    // fractional balance differs from integer credits by less than one grain.
    if (valid) days.push({ start, end: start + DAY, net: Number(net) / 2 ** 64 / 1e8, intervals });
  }
  return days;
}

export function kryptexDays(chart, rewards, t = now()) {
  if (!Array.isArray(chart) || !Array.isArray(rewards)) throw new Error("source_data");
  return rewards.flatMap((r) => {
    const start = number(r.timestamp) / 1000, net = number(r.reward_transferred);
    if (!Number.isSafeInteger(start) || start % DAY || start + DAY > t || number(r.reward) !== 0 || net == null || net < 0) return [];
    const samples = chart.filter((p) => start < p.timestamp / 1000 && p.timestamp / 1000 <= start + DAY).sort((a, b) => a.timestamp - b.timestamp);
    if (samples.length !== 144 || samples.some((p, i) => p.timestamp / 1000 !== start + (i + 1) * 600 || number(p.hashrate) == null || number(p.hashrate) < 0)) return [];
    return [{ start, end: start + DAY, net, intervals: samples.map((p) => ({ start: p.timestamp / 1000 - 600, end: p.timestamp / 1000, hashrate: number(p.hashrate) })) }];
  });
}

export function f2poolDays(income, chart, t = now()) {
  const rates = new Map((chart?.data?.hashrate_history?.values || []).map((p) => [p[0] / 1000, number(p[1])]));
  return (income?.data?.income_data || []).flatMap((r) => {
    const end = number(r.created_at), start = end - DAY, net = number(r.amount), rate = rates.get(start);
    if (r.type !== "revenue" || !String(r.comment || "").includes("PPS") || !Number.isSafeInteger(end) || end % DAY || end > t ||
        net == null || net < 0 || !(rate >= 100)) return []; // Discard tiny residual days, as in the audit.
    return [{ start, end, net, intervals: [{ start, end, hashrate: rate * 1e12 }] }];
  });
}

export function calculateMeasurement(pool, cohorts, points, t = now()) {
  if (!POOLS[pool] || !cohorts.length) throw new Error("no_samples");
  const computed = cohorts.map((days) => new Map(days.flatMap((d) => {
    try {
      const expected = d.intervals.reduce((sum, interval) => sum + expectedEarnings(points, interval), 0);
      return expected > 0 && Number.isFinite(d.net) && d.net >= 0 ? [[d.start, { ...d, expected }]] : [];
    } catch { return []; }
  })));
  const starts = [...computed[0].keys()].sort((a, b) => b - a);
  for (const last of starts) {
    const start = last - (DAYS - 1) * DAY, end = last + DAY;
    if (end > t || end <= t - 31 * DAY) continue;
    let netPRL = 0, expectedPRL = 0, valid = true;
    for (let day = start; day < end; day += DAY) for (const cohort of computed) {
      const value = cohort.get(day);
      if (!value) { valid = false; break; }
      netPRL += value.net; expectedPRL += value.expected;
    }
    const result = { pool, scheme: POOLS[pool], netPRL, expectedPRL, start, end,
      measuredAt: t, estimated: true, sampleCount: DAYS, theoryBasis: "hashrate_chain" };
    if (valid && validMeasurement(result, t)) return result;
  }
  throw new Error("no_complete_window");
}

function configuration(env) {
  try {
    const samples = JSON.parse(env.REAL_FEE_SAMPLES || "[]");
    if (!Array.isArray(samples) || samples.length > 12) return [];
    return samples.flatMap((s) => {
      const target = sanitizeTarget(s?.pool, s?.addr, s?.acct);
      return POOLS[s?.pool] && target ? [{ pool: s.pool, target }] : [];
    });
  } catch { return []; }
}
async function getJSON(env, pool, url, headers = {}) {
  if (!await reserveBudget(env.DB, pool, 1, now())) throw new Error("busy");
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (r.status !== 200) throw new Error("upstream");
  return JSON.parse(await readCapped(r, MAX_BODY));
}
async function collect(env, { pool, target }, t) {
  const address = encodeURIComponent(target);
  if (pool === "Pearl Fortune") return fortuneDays(await getJSON(env, pool, `https://pearlfortune.org/api/v1/miners/${address}/hourly-shares?hours=360&tz_offset_min=0`), t);
  if (pool === "Kryptex") {
    const base = `https://prl-api.kryptex.network/api/v1/miner/`;
    const [chart, rewards] = await Promise.all([getJSON(env, pool, `${base}chart/${address}?days=30`), getJSON(env, pool, `${base}worker-reward-chart/${address}`)]);
    return kryptexDays(chart, rewards, t);
  }
  const base = new URL(SOURCES.F2Pool.url(target)), cut = target.indexOf("/"), account = cut < 0 ? "" : target.slice(cut + 1);
  const request = (action, params) => {
    const url = new URL(base); url.searchParams.set("action", action);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return getJSON(env, pool, url.href, SOURCES.F2Pool.headers);
  };
  const [income, chart] = await Promise.all([request("load_payout_history_income", { account, currency_code: "prl" }), request("load_by_duration", { duration: "30" })]);
  return f2poolDays(income, chart, t);
}

// Called by the existing minute cron. Per-pool atomic leases make work hourly,
// independent of clients or edge regions; failures retain the last dated result.
export async function refreshRealFees(env) {
  const samples = configuration(env), t = now();
  for (const pool of Object.keys(POOLS)) {
    const group = samples.filter((s) => s.pool === pool).slice(0, 4);
    if (!group.length) continue;
    const leaseKey = `realfees:lease:${pool}`, token = crypto.randomUUID();
    const lease = await env.DB.prepare(`INSERT INTO kv (k,v,ts) VALUES (?,?,?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v,ts=excluded.ts WHERE kv.ts<=?`)
      .bind(leaseKey, token, t, t - 3600).run();
    if (!lease.meta.changes) continue;
    try {
      const cohorts = [];
      for (const sample of group) cohorts.push(await collect(env, sample, t));
      const days = cohorts.flat(), start = Math.min(...days.map((d) => d.start));
      if (!days.length) throw new Error("no_samples");
      const { results: points } = await env.DB.prepare("SELECT height,ts,difficulty FROM network_samples WHERE ts>=? ORDER BY ts,height")
        .bind(start - 3 * DAY).all();
      const distinct = points.filter((p, i) => !i || p.ts > points[i - 1].ts);
      const observation = calculateMeasurement(pool, cohorts, distinct, t);
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(key(pool), JSON.stringify(observation), t),
        env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(`realfees:last-success:${pool}`, "1", t),
      ]);
    } catch {
      // Never log an upstream URL, credential, account identifier or response.
      console.warn("real-fee sample unavailable", pool);
      await env.DB.prepare("UPDATE kv SET ts=? WHERE k=? AND v=?").bind(t - 3300, leaseKey, token).run();
    }
  }
}
