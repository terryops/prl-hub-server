// Rolling, count-based output estimates. The pool reports share work;
// intervals cover count randomness, not independent verification of that work.
export const HERO = "https://pearl.herominers.com/";
export const SHARE_YIELD_DAYS = 30;
const DAY = 86400, MIN_DAYS = 5, MIN_BLOCKS = 100, MAX_BLOCKS = 10000, COVERAGE = .9;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

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

export function validRollingShareMeasurement(o, t) {
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(finite) && v[0] <= v[1];
  const hero = o?.id === HERO && o.pool === "HeroMiners" && o.theoryBasis === "accepted_share_rounds";
  return !!o && hero && o.scheme === "PPLNS" && o.displayFactor == null && o.prior == null && o.since == null &&
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
