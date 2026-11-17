// Rolling, count-based output estimates. The pool reports share work;
// intervals cover count randomness, not independent verification of that work.
export const HERO = "https://pearl.herominers.com/";
export const PEARLHASH = "https://pearlhash.xyz/";
export const SHARE_YIELD_DAYS = 30;
const DAY = 86400, MIN_DAYS = 5, MIN_BLOCKS = 100, MAX_BLOCKS = 10000, COVERAGE = .9, FACTOR_TOL = .005, FACTOR_SHIFT = .02;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

function segmentSummary(days, retained, feePercent) {
  let blocks = 0, work = 0, shown = 0;
  for (const d of days) { blocks += d[2]; work += d[3]; shown += d[4]; }
  if (!(work > 0) || blocks < 0 || blocks > MAX_BLOCKS) return null;
  const ci = poissonInterval(blocks).map((v) => v / work), ratio = retained * blocks / work;
  return { start: days[0][0], end: days.at(-1)[0] + DAY, poolBlocks: blocks, blocksSample: blocks, orphans: 0,
    work, factor: shown / work, feePercent, foundYield: blocks / work, foundYield95: ci,
    ratio, percent: (1 - ratio) * 100,
    cost95: [100 * (1 - retained * ci[1]), 100 * (1 - retained * ci[0])] };
}

function pearlHashFactorBreakdown(byDay, end, retained, feePercent) {
  const full = [];
  for (let day = end - DAY; day >= end - 60 * DAY; day -= DAY) {
    const d = byDay.get(day);
    if (!d || d[1] < COVERAGE * DAY || !(d[3] > 0)) break;
    full.push(d);
  }
  full.reverse();
  if (full.length < MIN_DAYS) return null;
  const lastF = full.at(-1)[4] / full.at(-1)[3];
  if (!finite(lastF) || !(lastF > 0 && lastF <= 1)) return null;
  let curStart = full.length;
  while (curStart > 0) {
    const d = full[curStart - 1], f = d[4] / d[3];
    if (!finite(f) || !(f > 0 && f <= 1) || Math.abs(f - lastF) > FACTOR_TOL) break;
    curStart--;
  }
  const curDays = full.slice(curStart);
  if (curDays.length < MIN_DAYS) return null;
  let cWork = 0, cShown = 0;
  for (const d of curDays) { cWork += d[3]; cShown += d[4]; }
  const factor = cShown / cWork;
  if (!(factor > 0 && factor <= 1)) return null;
  const displayFactor = { since: curDays[0][0], factor, percent: (1 - retained * factor) * 100, feePercent };
  // Check whether an earlier stable factor regime (>= MIN_DAYS, shifted by > 2%) precedes up to 3 transition days.
  for (let priorEnd = curStart; priorEnd >= MIN_DAYS && curStart - priorEnd <= 3; priorEnd--) {
    const prevF = full[priorEnd - 1][4] / full[priorEnd - 1][3];
    if (!finite(prevF) || !(prevF > 0 && prevF <= 1) || Math.abs(prevF - factor) <= FACTOR_SHIFT) continue;
    let priorStart = priorEnd;
    while (priorStart > 0) {
      const d = full[priorStart - 1], f = d[4] / d[3];
      if (!finite(f) || !(f > 0 && f <= 1) || Math.abs(f - prevF) > FACTOR_TOL) break;
      priorStart--;
    }
    if (priorEnd - priorStart < MIN_DAYS) continue;
    const prior = segmentSummary(full.slice(priorStart, priorEnd), retained, feePercent);
    const since = segmentSummary(full.slice(priorEnd), retained, feePercent);
    if (prior && prior.poolBlocks >= MIN_BLOCKS && since && since.poolBlocks >= MIN_BLOCKS) return { displayFactor, prior, since };
  }
  return { displayFactor };
}

// Stable inversion of the Poisson CDF (Garwood limits). Counts are at most 3000.
export function poissonInterval(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_BLOCKS) throw new Error("count_range");
  const logFactorial = [0];
  for (let k = 1; k <= count; k++) logFactorial[k] = logFactorial[k - 1] + Math.log(k);
  const cdf = (n, mean) => {
    if (mean === 0) return 1;
    const logs = [], logMean = Math.log(mean);
    let peak = -Infinity;
    for (let k = 0; k <= n; k++) { const v = -mean + k * logMean - logFactorial[k]; logs.push(v); peak = Math.max(peak, v); }
    let sum = 0;
    for (const v of logs) sum += Math.exp(v - peak);
    return Math.min(1, Math.exp(peak) * sum);
  };
  const invert = (n, probability) => {
    let low = 0, high = Math.max(10, 2 * n + 100);
    while (cdf(n, high) > probability) high *= 2;
    for (let i = 0; i < 64; i++) {
      const middle = (low + high) / 2;
      if (cdf(n, middle) > probability) low = middle; else high = middle;
    }
    return (low + high) / 2;
  };
  return [count ? invert(count - 1, .975) : 0, invert(count, .025)];
}

export function rollingShareMeasurement(effort, feePercent, t) {
  if (!effort || effort.sourceVersion !== 2 || !finite(effort.since) || !finite(effort.observedAt) || effort.observedAt < t - 1800 ||
      effort.observedAt > t + 60 || !Array.isArray(effort.blocks) || !effort.blocks.length ||
      effort.blocks.length > MAX_BLOCKS || !finite(feePercent) || feePercent < 0 || feePercent > 100) return null;
  const end = Math.floor(t / DAY) * DAY;
  const start = Math.max(end - SHARE_YIELD_DAYS * DAY, Math.ceil(effort.since / DAY) * DAY);
  if (end - start < MIN_DAYS * DAY) return null;
  let blocks = 0, orphans = 0, work = 0, previousHeight = 0, previousTime = 0;
  for (const b of effort.blocks) {
    if (!Array.isArray(b) || !Number.isSafeInteger(b[0]) || b[0] <= previousHeight ||
        !finite(b[1]) || b[1] < previousTime || !finite(b[2]) || b[2] < 0 || (b[3] !== 0 && b[3] !== 1)) return null;
    previousHeight = b[0]; previousTime = b[1];
    if (b[1] < start || b[1] >= end) continue;
    blocks++; orphans += b[3]; work += b[2];
  }
  if (blocks < MIN_BLOCKS || !(work > 0)) return null;
  const canonical = blocks - orphans, retained = 1 - feePercent / 100;
  const foundYield95 = poissonInterval(blocks).map((v) => v / work);
  const canonical95 = poissonInterval(canonical).map((v) => v / work);
  const result = { id: HERO, pool: "HeroMiners", scheme: "PPLNS", theoryBasis: "accepted_share_rounds",
    start, end, measuredAt: effort.observedAt, estimated: true, targetDays: SHARE_YIELD_DAYS,
    blocksSample: canonical, poolBlocks: blocks, orphans, work, feePercent,
    foundYield: blocks / work, foundYield95,
    ratio: retained * canonical / work,
    cost95: [100 * (1 - retained * canonical95[1]), 100 * (1 - retained * canonical95[0])],
    confidence: .95, confidenceMethod: "poisson_count_only", sourceVersion: 2 };
  return validRollingShareMeasurement(result, t) ? result : null;
}

export function rollingPearlHashMeasurement(record, feePercent, t) {
  const last = record?.last, days = record?.days;
  if (!last || !finite(last.ts) || last.ts < t - 1800 || last.ts > t + 60 || !Array.isArray(days) || !days.length ||
      !finite(feePercent) || feePercent < 0 || feePercent > 100) return null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!Array.isArray(d) || d.length !== 5 || !Number.isSafeInteger(d[0]) || d[0] <= 0 || d[0] % DAY !== 0 ||
        !Number.isSafeInteger(d[2]) || d.slice(1).some((v) => !finite(v) || v < 0) || (i && d[0] <= days[i - 1][0])) return null;
  }
  const end = Math.floor(t / DAY) * DAY, byDay = new Map(days.map((d) => [d[0], d]));
  let start = end, canonical = 0, work = 0;
  for (let day = end - DAY; day >= end - SHARE_YIELD_DAYS * DAY; day -= DAY) {
    const d = byDay.get(day);
    if (!d || d[1] < COVERAGE * DAY || !(d[3] > 0)) break;
    start = day; canonical += d[2]; work += d[3];
  }
  if (end - start < MIN_DAYS * DAY || canonical < MIN_BLOCKS || canonical > MAX_BLOCKS || !(work > 0)) return null;
  const retained = 1 - feePercent / 100;
  const canonical95 = poissonInterval(canonical).map((v) => v / work);
  const breakdown = pearlHashFactorBreakdown(byDay, end, retained, feePercent);
  const result = { id: PEARLHASH, pool: "PearlHash", scheme: "PPLNS", theoryBasis: "accepted_share_work",
    start, end, measuredAt: last.ts, estimated: true, targetDays: SHARE_YIELD_DAYS,
    blocksSample: canonical, poolBlocks: canonical, orphans: 0, work, feePercent,
    foundYield: canonical / work, foundYield95: canonical95,
    ratio: retained * canonical / work,
    cost95: [100 * (1 - retained * canonical95[1]), 100 * (1 - retained * canonical95[0])],
    ...(breakdown || {}),
    confidence: .95, confidenceMethod: "poisson_count_only", sourceVersion: 2 };
  return validRollingShareMeasurement(result, t) ? result : null;
}

function validSegment(s, feePercent) {
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(finite) && v[0] <= v[1];
  return !!s && Number.isSafeInteger(s.start) && s.start > 0 && s.start % DAY === 0 &&
    Number.isSafeInteger(s.end) && s.end % DAY === 0 && s.end - s.start >= MIN_DAYS * DAY && s.end - s.start <= 60 * DAY &&
    Number.isSafeInteger(s.poolBlocks) && s.poolBlocks >= MIN_BLOCKS && s.poolBlocks <= MAX_BLOCKS &&
    s.orphans === 0 && s.blocksSample === s.poolBlocks && finite(s.work) && s.work > 0 &&
    finite(s.factor) && s.factor > 0 && s.factor <= 1 && s.feePercent === feePercent &&
    finite(s.foundYield) && Math.abs(s.foundYield - s.poolBlocks / s.work) < 1e-9 &&
    finite(s.ratio) && Math.abs(s.ratio - (1 - feePercent / 100) * s.blocksSample / s.work) < 1e-9 &&
    finite(s.percent) && Math.abs(s.percent - (1 - s.ratio) * 100) < 1e-6 &&
    pair(s.foundYield95) && pair(s.cost95);
}

export function validRollingShareMeasurement(o, t) {
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(finite) && v[0] <= v[1];
  const hero = o?.id === HERO && o.pool === "HeroMiners" && o.theoryBasis === "accepted_share_rounds";
  const pearlhash = o?.id === PEARLHASH && o.pool === "PearlHash" && o.theoryBasis === "accepted_share_work" && o.orphans === 0;
  const df = o?.displayFactor;
  const validDF = df == null || (pearlhash && Number.isSafeInteger(df.since) && df.since > 0 && df.since % DAY === 0 &&
    df.since <= o.end - MIN_DAYS * DAY && finite(df.factor) && df.factor > 0 && df.factor <= 1 &&
    df.feePercent === o.feePercent && finite(df.percent) && Math.abs(df.percent - (1 - (1 - o.feePercent / 100) * df.factor) * 100) < 1e-6);
  const hasSplit = o?.prior != null || o?.since != null;
  const validSplit = !hasSplit || (pearlhash && df != null && validSegment(o.prior, o.feePercent) && validSegment(o.since, o.feePercent) &&
    o.prior.end === o.since.start && o.since.end === o.end);
  return !!o && (hero || pearlhash) && o.scheme === "PPLNS" && validDF && validSplit &&
    o.sourceVersion === 2 && o.estimated === true && o.targetDays === SHARE_YIELD_DAYS &&
    Number.isSafeInteger(o.start) && o.start > 0 && o.start % DAY === 0 && Number.isSafeInteger(o.end) && o.end % DAY === 0 &&
    o.end === Math.floor(t / DAY) * DAY && o.end - o.start >= MIN_DAYS * DAY && o.end - o.start <= SHARE_YIELD_DAYS * DAY &&
    finite(o.measuredAt) && o.measuredAt >= o.end && o.measuredAt >= t - 1800 && o.measuredAt <= t + 60 &&
    Number.isSafeInteger(o.poolBlocks) && o.poolBlocks >= MIN_BLOCKS && o.poolBlocks <= MAX_BLOCKS &&
    Number.isSafeInteger(o.orphans) && o.orphans >= 0 && o.orphans <= o.poolBlocks && o.blocksSample === o.poolBlocks - o.orphans &&
    finite(o.work) && o.work > 0 && finite(o.feePercent) && o.feePercent >= 0 && o.feePercent <= 100 &&
    finite(o.ratio) && o.ratio >= 0 && o.ratio <= 2 && finite(o.foundYield) && o.foundYield > 0 &&
    Math.abs(o.foundYield - o.poolBlocks / o.work) < 1e-9 &&
    Math.abs(o.ratio - (1 - o.feePercent / 100) * o.blocksSample / o.work) < 1e-9 &&
    pair(o.foundYield95) && o.foundYield95[0] >= 0 && o.foundYield95[0] <= o.foundYield && o.foundYield95[1] >= o.foundYield &&
    pair(o.cost95) && o.cost95[0] <= (1 - o.ratio) * 100 + 1e-9 && o.cost95[1] >= (1 - o.ratio) * 100 - 1e-9 &&
    o.confidence === .95 && o.confidenceMethod === "poisson_count_only";
}
