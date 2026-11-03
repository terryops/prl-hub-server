// Server-owned PPS measurements and public PPLNS output estimates. Sampling credentials stay in a
// Worker secret; neither addresses nor read-only capabilities enter public JSON.
import { readCapped, MAX_BODY, UA, SOURCES, sanitizeTarget } from "./pools.js";
import { reserveBudget } from "./poolstats.js";
import { now, webJson as json } from "./http.js";
import { validPPLNSMeasurement, costEstimated } from "./pplns.js";

const DAY = 86400, DAYS = 5, WORK = 2 ** 48, EMISSION = 650226n;
const POOLS = { "Pearl Fortune": "PPS", Kryptex: "PPS+", F2Pool: "PPS" };
const key = (pool) => `public:realfees:${pool}`;
const number = (v) => (typeof v === "number" || typeof v === "string") && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const unwrap = (v) => v?.data || v;
// A window ends at the latest 00:00 UTC, or the one before while pools still settle
// yesterday. Anything older is history: never served, never searched for.
const oldestEnd = (t) => Math.floor(t / DAY) * DAY - DAY;
const current = (end, t) => end <= t && end >= oldestEnd(t);

// Peryn's PPS+ is measured per fee tier: its Founding Miners' addresses and everyone else's (perynMeasurement).
const PERYN = "Peryn", PERYN_TIERS = ["founding", "standard"], PERYN_MIN_DAYS = 3;
const perynKey = (tier) => key(`${PERYN}:${tier}`);
const KEYS = [...Object.keys(POOLS).map(key), ...PERYN_TIERS.map(perynKey)];

export function validMeasurement(o, t = now()) {
  return !!o && (POOLS[o.pool] === o.scheme && o.tier == null ||
      o.pool === PERYN && o.scheme === "PPS+" && PERYN_TIERS.includes(o.tier) && o.activeDays >= PERYN_MIN_DAYS) &&
    o.theoryBasis === "hashrate_chain" &&
    Number.isFinite(o.netPRL) && o.netPRL >= 0 && Number.isFinite(o.expectedPRL) && o.expectedPRL > 0 &&
    Number.isSafeInteger(o.start) && o.start > 0 && Number.isSafeInteger(o.end) &&
    o.end - o.start === DAYS * DAY && o.start % DAY === 0 && current(o.end, t) &&
    Number.isFinite(o.measuredAt) && o.measuredAt >= o.end && o.measuredAt <= t + 60 &&
    o.sampleCount === DAYS && typeof o.estimated === "boolean";
}

export async function readRealFees(db, t = now()) {
  const { results } = await db.prepare(`SELECT v FROM kv WHERE k IN (${KEYS.map(() => "?").join(", ")})`)
    .bind(...KEYS).all();
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
  if (!costEstimated(row, payout)) return null;
  const sample = measurements.find((o) => o.id === row.id && o.pool === row.name && validPPLNSMeasurement(o));
  // Luck taken out: the fee and the work the pool loses (see pplnsMeasurement).
  return sample ? { percent: (1 - sample.ratio) * 100, start: sample.start, end: sample.end } : null;
}

// Blocks per accepted share, where a pool measurably turns its shares into fewer blocks than they imply.
// PearlHash, 2026-11-01: its share target is the chain's (difficulty 128 = 2^208 / 128, read from the jobs it
// sends), yet over 12 days it found 1,230 blocks where its accepted shares imply 1,339 (0.918 ± 0.026); its own
// displayed hashrate is its share rate × 0.915 × 2^48. Real Cost counts that loss with the fee:
// 100 − (100 − cost) × yield, and the payout carries `shareYield` for the bubble beside the figure.
// HeroMiners, 2026-11-02: it credits shares at full value (6 h of our own 4090 on it: credited ÷ the card's own
// reading 0.988 ± 0.035, 0.998 after the miner's 1% fee), yet from Oct 4 to Nov 1 its blocks were 0.907 ± 0.038 of
// what its shares imply (Pearl Fortune over the same weeks 1.009); its displayed hashrate is 0.952–0.959 × its share
// rate and its blocks follow that. The rest of the gap is left to luck, as everywhere else.
const SHARE_YIELD = { PearlHash: 0.915, HeroMiners: 0.955 };

const measuredPercent = (o) => (1 - o.netPRL / o.expectedPRL) * 100;

export function attachRealFees(snapshot, measurements, pplnsMeasurements = []) {
  return { ...snapshot, rows: snapshot.rows.map((row) => {
    const own = measurements.filter((o) => o.pool === row.name && validMeasurement(o));
    // Peryn: the Founding Miners' figure while its sign-ups are open (the payout then carries `founding`, the terms a
    // new miner gets), everyone else's once they close; the other tier when only one was measured. Both go in
    // `realFeeTiers` for the bubble beside the figure.
    const tiers = row.name === PERYN ? Object.fromEntries(own.filter((o) => o.tier).map((o) => [o.tier, o])) : null;
    const open = (row.payouts || []).some((p) => p.scheme === "PPS+" && p.founding);
    const observation = tiers ? (open ? ["founding", "standard"] : ["standard", "founding"]).map((k) => tiers[k]).find(Boolean)
      : own.find((o) => o.tier == null);
    const matches = !row.solo && observation && (row.payouts || []).some((p) => !p.solo && p.scheme === observation.scheme);
    return { ...row, realFeeMeasurement: matches ? observation : null,
      payouts: row.payouts?.map((p) => {
        const measured = matches && !p.solo && p.scheme === observation.scheme;
        const estimate = pplnsEstimate(row, p, pplnsMeasurements);
        const percent = measured ? measuredPercent(observation) : estimate?.percent ?? null;
        const shareYield = !row.solo && !p.solo && Object.hasOwn(SHARE_YIELD, row.name) ? SHARE_YIELD[row.name] : null;
        const cost = percent != null && shareYield ? 100 - (100 - percent) * shareYield : percent;
        return { ...p, ...(shareYield && cost != null ? { shareYield } : {}),
          ...(measured && observation.tier ? { realFeeTier: observation.tier,
            realFeeTiers: Object.fromEntries(PERYN_TIERS.map((k) => [k, tiers[k] ? measuredPercent(tiers[k]) : null])) } : {}),
          realFeePercent: cost,
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
  if (hashrate === 0) return 0;
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
    const start = number(r.timestamp) / 1000;
    if (!Number.isSafeInteger(start) || start % DAY || start + DAY > t || number(r.reward) !== 0) return [];
    const samples = chart.filter((p) => start < p.timestamp / 1000 && p.timestamp / 1000 <= start + DAY).sort((a, b) => a.timestamp - b.timestamp);
    if (samples.length !== 144 || samples.some((p, i) => p.timestamp / 1000 !== start + (i + 1) * 600 || number(p.hashrate) == null || number(p.hashrate) < 0)) return [];
    // An idle day has no transfer at all; a day with work and no transfer is unsettled.
    const net = number(r.reward_transferred) ?? (samples.every((p) => number(p.hashrate) === 0) ? 0 : null);
    if (net == null || net < 0) return [];
    return [{ start, end: start + DAY, net, intervals: samples.map((p) => ({ start: p.timestamp / 1000 - 600, end: p.timestamp / 1000, hashrate: number(p.hashrate) })) }];
  });
}

export function f2poolDays(income, chart, t = now()) {
  const rates = new Map((chart?.data?.hashrate_history?.values || []).map((p) => [p[0] / 1000, number(p[1])]));
  const paid = (income?.data?.income_data || []).flatMap((r) => {
    const end = number(r.created_at), start = end - DAY, net = number(r.amount), rate = rates.get(start);
    if (r.type !== "revenue" || !String(r.comment || "").includes("PPS") || !Number.isSafeInteger(end) || end % DAY || end > t ||
        net == null || net < 0 || !(rate >= 100)) return []; // Discard tiny residual days, as in the audit.
    return [{ start, end, net, intervals: [{ start, end, hashrate: rate * 1e12 }] }];
  });
  // Below that residual threshold a finished day is idle: complete, nothing earned or expected.
  const idle = [...rates].flatMap(([start, rate]) =>
    Number.isSafeInteger(start) && start % DAY === 0 && start + DAY <= t && rate != null && rate >= 0 && rate < 100
      ? [{ start, end: start + DAY, net: 0, intervals: [{ start, end: start + DAY, hashrate: 0 }] }] : []);
  return [...paid, ...idle];
}

export function calculateMeasurement(pool, cohorts, points, t = now()) {
  if (!POOLS[pool] || !cohorts.length) throw new Error("no_samples");
  const computed = cohorts.map((days) => new Map(days.flatMap((d) => {
    try {
      const expected = d.intervals.reduce((sum, interval) => sum + expectedEarnings(points, interval), 0);
      // An idle day (no work, no pay) is complete and adds nothing to either side, so the
      // latest five days still measure whatever was mined in them.
      return Number.isFinite(d.net) && d.net >= 0 && (expected > 0 || expected === 0 && d.net === 0) ? [[d.start, { ...d, expected }]] : [];
    } catch { return []; }
  })));
  const starts = [...computed[0].keys()].sort((a, b) => b - a);
  for (const last of starts) {
    const start = last - (DAYS - 1) * DAY, end = last + DAY;
    if (!current(end, t)) continue;
    let netPRL = 0, expectedPRL = 0, activeDays = 0, valid = true;
    for (let day = start; valid && day < end; day += DAY) {
      const values = computed.map((cohort) => cohort.get(day));
      if (values.some((v) => !v)) { valid = false; break; }
      for (const v of values) { netPRL += v.net; expectedPRL += v.expected; }
      if (values.some((v) => v.expected > 0)) activeDays++;
    }
    // Five idle days leave expectedPRL at 0, which validMeasurement rejects.
    const result = { pool, scheme: POOLS[pool], netPRL, expectedPRL, start, end,
      measuredAt: t, estimated: true, sampleCount: DAYS, activeDays, theoryBasis: "hashrate_chain" };
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

// Public lists of active miners, for when the configured samples have not mined all of the
// latest five days. Pearl Fortune masks block finders, but its latest block's share snapshot
// names every contributor in full, largest first here; a PPLNS miner there has no PPS income,
// so its days never validate. Kryptex labels each block's scheme. F2Pool has no public
// per-account data.
const DISCOVER = {
  "Pearl Fortune": async (env) => {
    const base = "https://pearlfortune.org/api/v1/blocks";
    const hash = (await getJSON(env, "Pearl Fortune", `${base}?page=1&page_size=1`))?.data?.blocks?.[0]?.block_hash;
    if (!/^[0-9a-f]{64}$/.test(hash || "")) return [];
    const extra = JSON.parse((await getJSON(env, "Pearl Fortune", `${base}/${hash}`))?.data?.extra_data || "{}");
    const shares = extra?.pearl_payment_snapshot?.shares_by_address || {};
    return Object.keys(shares).sort((a, b) => (number(shares[b]) ?? 0) - (number(shares[a]) ?? 0));
  },
  Kryptex: async (env) => (await getJSON(env, "Kryptex", "https://prl-api.kryptex.network/api/v1/pool/blocks"))
    ?.results?.filter((b) => String(b?.scheme).toLowerCase() === "pps").map((b) => b.miner) || [],
};
const TRIES = 3; // new candidates per pool per hour
const autoKey = (pool) => `realfees:auto:${pool}`;

// Called by the existing minute cron. Per-pool atomic leases make work hourly,
// independent of clients or edge regions; a failure keeps the last result only
// while it is still current, and deletes it once it is history.
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
      // Only days that can fall in a current window need chain history.
      const { results: points } = await env.DB.prepare("SELECT height,ts,difficulty FROM network_samples WHERE ts>=? ORDER BY ts,height")
        .bind(oldestEnd(t) - (DAYS + 3) * DAY).all();
      const distinct = points.filter((p, i) => !i || p.ts > points[i - 1].ts);
      // The window with the most mined days wins; the configured samples win ties.
      let best = null, bestAuto = null;
      const consider = async (targets, auto = null) => {
        try {
          const cohorts = [];
          for (const target of targets) cohorts.push(await collect(env, { pool, target }, t));
          const o = calculateMeasurement(pool, cohorts, distinct, t);
          if (!best || o.activeDays > best.activeDays) { best = o; bestAuto = auto; }
        } catch {}
      };
      await consider(group.map((s) => s.target));
      let stored = null;
      if (DISCOVER[pool] && !(best?.activeDays >= DAYS)) {
        stored = (await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(autoKey(pool)).first())?.v ?? null;
        const tried = new Set(group.map((s) => s.target));
        if (stored && !tried.has(stored)) { tried.add(stored); await consider([stored], stored); }
        if (!(best?.activeDays >= DAYS)) {
          let found = [];
          try { found = await DISCOVER[pool](env); } catch {}
          const fresh = [...new Set(found.map((a) => sanitizeTarget(pool, a)).filter((a) => a && !tried.has(a)))];
          for (const target of fresh.slice(0, TRIES)) {
            await consider([target], target);
            if (best?.activeDays >= DAYS) break;
          }
        }
      }
      if (!best) throw new Error("no_complete_window");
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(key(pool), JSON.stringify(best), t),
        env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(`realfees:last-success:${pool}`, "1", t),
        ...(bestAuto && bestAuto !== stored ? [env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(autoKey(pool), bestAuto, t)] : []),
      ]);
    } catch {
      // Never log an upstream URL, credential, account identifier or response.
      console.warn("real-fee sample unavailable", pool);
      await env.DB.batch([
        env.DB.prepare("UPDATE kv SET ts=? WHERE k=? AND v=?").bind(t - 3300, leaseKey, token),
        // CASE evaluates lazily, so a malformed value is deleted instead of failing json_extract.
        env.DB.prepare(`DELETE FROM kv WHERE k=? AND CASE WHEN json_valid(v)
          THEN coalesce(json_extract(v, '$.end'), 0) < ? ELSE 1 END`).bind(key(pool), oldestEnd(t)),
      ]);
    }
  }
  await refreshPerynFees(env);
}

// ── Peryn (peryn.ai): PPS+ per fee tier ───────────────────────────────────────────────────────────────────────
// Its public dashboard for an address (app.peryn.ai/address/<a>, no sign-in) states the PPS+ fee that address pays
// ("PPS+ · 0.5% fee (Founding Miner)" or "PPS+ · 1% fee"), and lists its hashrate per UTC day for 7 days (credited
// share difficulty over the day, three significant figures) and the $PEARL credited per day for 14 (two decimals)
// beside Peryn's own prediction. Its JSON API (/api/v1/miner) has no history. Addresses come from its payout
// batches (/api/v1/payments, each transaction's outputs less the pool's own inputs), largest first.
// 2026-11-03, Oct 29 – Nov 2 against this chain integral: Founding Miner addresses 0.78% (11 addresses, 26 days),
// everyone else 1.26% (4, 10); "Founding Miner Claimed" badges that still state 1% count with the 1%.
// A day counts when the address mined the day before too (a first day comes ~2% short: what is credited a few
// minutes late lands on the next day) and Peryn's prediction is within 3% of ours (a day with PPLNS work, or a
// misread figure, is not a PPS+ day).
const PERYN_APP = "https://app.peryn.ai", PERYN_TX = "https://blockbook.pearlresearch.ai/api/v2/tx/";
const PERYN_PAYMENTS = 12, PERYN_PAGES = 24, PERYN_PAGE_BYTES = 4_000_000, PERYN_SETTLE = 1800, PERYN_BATCH = 4;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HASH_UNITS = { H: 1, kH: 1e3, KH: 1e3, MH: 1e6, GH: 1e9, TH: 1e12, PH: 1e15, EH: 1e18 };
const figure = (s) => { const v = Number(String(s).replace(/,/g, "")); return Number.isFinite(v) && v >= 0 ? v : null; };
// "28 Oct" on a page read at t: the latest such day not after t.
function perynDay(d, m, t) {
  const month = MONTHS.indexOf(m), day = Number(d);
  if (month < 0 || !(day >= 1 && day <= 31)) return null;
  const year = new Date(t * 1000).getUTCFullYear();
  for (const y of [year, year - 1]) {
    const s = Date.UTC(y, month, day) / 1000;
    if (new Date(s * 1000).getUTCDate() === day && s <= t) return s;
  }
  return null;
}

export function perynPayees(txs) {
  const pool = new Set(), paid = new Map();
  for (const tx of txs) for (const v of tx?.vin || []) for (const a of v?.addresses || []) pool.add(a);
  for (const tx of txs) for (const o of tx?.vout || []) {
    const a = o?.addresses?.[0], v = number(o?.value);
    if (typeof a !== "string" || !/^prl1[0-9a-z]{20,100}$/.test(a) || pool.has(a) || v == null || v <= 0) continue;
    paid.set(a, (paid.get(a) || 0) + v);
  }
  return [...paid].sort((a, b) => b[1] - a[1]).map(([a]) => a);
}

// One address's dashboard: its tier and days, or null unless every worker shown is on PPS+.
export function perynAddress(html, t = now()) {
  if (typeof html !== "string") return null;
  const fee = html.match(/>PPS\+ · ([0-9.]+)% fee( \(Founding Miner\))?</);
  const mode = html.match(/data-payout-mode="[^"]*">([^<]*)</);
  if (!fee || !mode || !/^PPS\+/.test(mode[1]) || />PPLNS</.test(html)) return null;
  const hashrate = new Map(), credit = new Map(), seen = new Set();
  for (const [, d, m, v, u] of html.matchAll(/<title>(\d{1,2}) ([A-Z][a-z]{2}): ([\d,.]+) ([kKMGTPE]?H)\/s<\/title>/g)) {
    const s = perynDay(d, m, t), h = figure(v);
    if (s == null || h == null) continue;
    if (hashrate.has(s)) seen.add(s);
    hashrate.set(s, h * HASH_UNITS[u]);
  }
  for (const [, d, m, p, a] of html.matchAll(/<title>(\d{1,2}) ([A-Z][a-z]{2}): predicted ([\d,.]+) \$PEARL, actual ([\d,.]+) \$PEARL<\/title>/g)) {
    const s = perynDay(d, m, t), predicted = figure(p), actual = figure(a);
    if (s == null || predicted == null || actual == null) continue;
    if (credit.has(s)) seen.add(s);
    credit.set(s, { predicted, actual });
  }
  // A day listed twice is ambiguous: neither reading counts.
  const days = [...credit].filter(([s]) => !seen.has(s)).map(([start, c]) => ({ start, ...c, hashrate: hashrate.get(start) ?? null }));
  return { tier: fee[2] ? "founding" : "standard", days };
}

export function perynMeasurement(tier, addresses, points, t = now()) {
  const end = Math.floor(t / DAY) * DAY, start = end - DAYS * DAY;
  let netPRL = 0, expectedPRL = 0;
  const days = new Set(), used = new Set();
  for (const [i, a] of addresses.entries()) {
    if (a?.tier !== tier) continue;
    const credited = new Map(a.days.map((d) => [d.start, d.actual]));
    for (const d of a.days) {
      if (d.start < start || d.start >= end || !(d.hashrate > 0) || !(d.actual > 0) || !(credited.get(d.start - DAY) > 0)) continue;
      let expected;
      try { expected = expectedEarnings(points, { start: d.start, end: d.start + DAY, hashrate: d.hashrate }); } catch { continue; }
      if (!(expected > 0) || !(Math.abs(d.predicted / expected - 1) < 0.03)) continue;
      netPRL += d.actual; expectedPRL += expected; days.add(d.start); used.add(i);
    }
  }
  const o = { pool: PERYN, scheme: "PPS+", tier, netPRL, expectedPRL, start, end, measuredAt: t, estimated: true,
    sampleCount: DAYS, activeDays: days.size, addresses: used.size, theoryBasis: "hashrate_chain" };
  if (!validMeasurement(o, t)) throw new Error("no_complete_window");
  return o;
}

async function getPage(env, url) {
  if (!await reserveBudget(env.DB, PERYN, 1, now())) throw new Error("busy");
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html", "accept-language": "en" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error("upstream");
  return readCapped(r, PERYN_PAGE_BYTES);
}
async function settled(items, read) {
  const out = [];
  for (let i = 0; i < items.length; i += PERYN_BATCH)
    out.push(...await Promise.allSettled(items.slice(i, i + PERYN_BATCH).map(read)));
  return out.flatMap((r) => r.status === "fulfilled" && r.value ? [r.value] : []);
}

// Once a day, half an hour after 00:00 UTC (Peryn credits a few minutes late); a failed read tries again next hour.
export async function refreshPerynFees(env) {
  const t = now(), end = Math.floor(t / DAY) * DAY, doneKey = `realfees:last-success:${PERYN}`;
  if (t - end < PERYN_SETTLE) return;
  if ((await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(doneKey).first())?.v === String(end)) return;
  const leaseKey = `realfees:lease:${PERYN}`, token = crypto.randomUUID();
  const lease = await env.DB.prepare(`INSERT INTO kv (k,v,ts) VALUES (?,?,?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v,ts=excluded.ts WHERE kv.ts<=?`)
    .bind(leaseKey, token, t, t - 3600).run();
  if (!lease.meta.changes) return;
  const outdated = PERYN_TIERS.map((tier) => env.DB.prepare(`DELETE FROM kv WHERE k=? AND CASE WHEN json_valid(v)
    THEN coalesce(json_extract(v, '$.end'), 0) < ? ELSE 1 END`).bind(perynKey(tier), oldestEnd(t)));
  try {
    const payments = (await getJSON(env, PERYN, `${PERYN_APP}/api/v1/payments?limit=${PERYN_PAYMENTS}`))?.payments;
    const txids = [...new Set((Array.isArray(payments) ? payments : []).flatMap((p) => Array.isArray(p?.txids) ? p.txids : []))]
      .filter((id) => /^[0-9a-f]{64}$/.test(id)).slice(0, 2 * PERYN_PAYMENTS);
    const txs = await settled(txids, (id) => getJSON(env, PERYN, PERYN_TX + id));
    if (!txids.length || txs.length < txids.length / 2) throw new Error("upstream");
    const targets = perynPayees(txs).slice(0, PERYN_PAGES);
    const read = await settled(targets, async (a) => ({ page: perynAddress(await getPage(env, `${PERYN_APP}/address/${a}`), t) }));
    if (!targets.length || read.length < targets.length / 2) throw new Error("upstream");
    const { results: points } = await env.DB.prepare("SELECT height,ts,difficulty FROM network_samples WHERE ts>=? ORDER BY ts,height")
      .bind(oldestEnd(t) - (DAYS + 3) * DAY).all();
    const distinct = points.filter((p, i) => !i || p.ts > points[i - 1].ts), pages = read.map((r) => r.page).filter(Boolean);
    const found = PERYN_TIERS.flatMap((tier) => { try { return [perynMeasurement(tier, pages, distinct, t)]; } catch { return []; } });
    await env.DB.batch([
      ...found.map((o) => env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(perynKey(o.tier), JSON.stringify(o), t)),
      // A tier without enough days this time keeps yesterday's figure only while it is still current.
      ...outdated,
      env.DB.prepare("INSERT OR REPLACE INTO kv (k,v,ts) VALUES (?,?,?)").bind(doneKey, String(end), t),
    ]);
  } catch {
    // Never log an address or a response.
    console.warn("real-fee sample unavailable", PERYN);
    await env.DB.batch(outdated);
  }
}
