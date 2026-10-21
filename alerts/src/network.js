import { chainHeight } from "./chain.js";
import { readCapped, UA, MAX_BODY, TIMEOUT_MS } from "./pools.js";
import { reserveBudget } from "./poolstats.js";
import { now, webJson as json, cached } from "./http.js";

const WORK = 2 ** 48; // hashes per unit of Pearl difficulty
const DAY = 86400; // seconds
const POINTS = 28; // native sampling density per backfill window
const MAX_POINTS = 256; // bounded response, including window endpoints
const WINDOW = 200; // blocks behind each hashrate and block-time estimate
const ANCHORS = [DAY, 3 * DAY, 7 * DAY, 30 * DAY]; // the changes clients show

/// Time and difficulty at `height`, interpolated between the samples (sorted by height) either side.
function sampleAt(samples, height) {
  if (!samples.length || height < samples[0].height || height > samples.at(-1).height) return null;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].height <= height) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi];
  if (a.height === height || b.height === a.height) return a;
  if (b.height === height) return b;
  const f = (height - a.height) / (b.height - a.height);
  return { ts: a.ts + f * (b.ts - a.ts), difficulty: a.difficulty + f * (b.difficulty - a.difficulty) };
}

/// Each point's block time and hashrate over the WINDOW blocks behind it: their time, and their work
/// (mean difficulty × 2^48) over it. Null without WINDOW blocks of samples behind the point. Where the
/// samples lie further apart than the window (early history), the estimate averages over the gap.
export function rollingSeries(points, samples) {
  return points.map((p) => {
    const from = sampleAt(samples, p.height - WINDOW);
    const blockTime = from && p.ts > from.ts ? (p.ts - from.ts) / WINDOW : null;
    return { height: p.height, ts: p.ts, difficulty: p.difficulty, hashrate: blockTime ? (p.difficulty + from.difficulty) / 2 * WORK / blockTime : null, blockTime };
  });
}

const SAMPLE = "SELECT height, ts, difficulty FROM network_samples";
/// The rows at `heights` (any order, repeats and nulls ignored), sorted by height.
async function rowsAt(db, heights) {
  const list = [...new Set(heights.filter(Number.isSafeInteger))];
  if (!list.length) return [];
  return (await db.prepare(`${SAMPLE} WHERE height IN (SELECT value FROM json_each(?)) ORDER BY height`).bind(JSON.stringify(list)).all()).results;
}

/// Up to MAX_POINTS samples across the span: the earliest of each time bucket and the newest, plus the
/// sample nearest each anchor (24h, 3d, 7d, 30d before the newest) that falls in or just before the
/// span. Every span holds the same anchor samples, so a change read from any of them agrees. Each pick
/// is one index lookup, so a span costs a few hundred row reads however many samples D1 holds (the
/// table grows by one or two a minute and is never trimmed; "all" once read it whole, every minute).
export async function spanSamples(db, from) {
  const tip = await db.prepare(`${SAMPLE} WHERE ts >= ? ORDER BY height DESC LIMIT 1`).bind(from).first();
  if (!tip) return [];
  const first = (await db.prepare("SELECT ts FROM network_samples WHERE ts >= ? ORDER BY ts LIMIT 1").bind(from).first()).ts;
  const last = (await db.prepare("SELECT ts FROM network_samples ORDER BY ts DESC LIMIT 1").first()).ts;
  const bucket = Math.max(1, Math.ceil((last - first) / (MAX_POINTS - 2 - ANCHORS.length)));
  const starts = [];
  for (let k = Math.floor(first / bucket); k <= Math.floor(last / bucket); k++) starts.push(Math.max(first, k * bucket));
  // The earliest sample at or after each bucket's start (an empty bucket yields the next one's: a repeat).
  const { results: firsts } = await db.prepare(`SELECT (SELECT height FROM network_samples WHERE ts >= t.value ORDER BY ts, height LIMIT 1) AS height
    FROM json_each(?) t`).bind(JSON.stringify(starts)).all();
  const targets = ANCHORS.map((back) => tip.ts - back).filter((target) => target >= from - 3600);
  const { results: around } = targets.length ? await db.prepare(`SELECT t.value AS target,
      (SELECT height FROM network_samples WHERE ts <= t.value ORDER BY ts DESC, height LIMIT 1) AS below,
      (SELECT height FROM network_samples WHERE ts >= t.value ORDER BY ts, height LIMIT 1) AS above
    FROM json_each(?) t`).bind(JSON.stringify(targets)).all() : { results: [] };
  const rows = await rowsAt(db, [tip.height, ...firsts.map((r) => r.height), ...around.flatMap((r) => [r.below, r.above])]);
  const byHeight = new Map(rows.map((r) => [r.height, r]));
  const anchors = around.map(({ target, below, above }) => {
    const a = byHeight.get(below), b = byHeight.get(above);
    if (!a || !b) return a || b;
    const da = Math.abs(a.ts - target), db_ = Math.abs(b.ts - target);
    return da < db_ || (da === db_ && a.height < b.height) ? a : b;
  });
  const picked = new Set([tip.height, ...firsts.map((r) => r.height), ...anchors.filter(Boolean).map((r) => r.height)]);
  return rows.filter((r) => picked.has(r.height));
}

/// The samples either side of each of `heights` (by height): what `rollingSeries` interpolates
/// between, two index lookups a point.
async function bracketing(db, heights) {
  if (!heights.length) return [];
  const { results } = await db.prepare(`SELECT (SELECT MAX(height) FROM network_samples WHERE height <= t.value) AS below,
      (SELECT MIN(height) FROM network_samples WHERE height >= t.value) AS above FROM json_each(?) t`).bind(JSON.stringify(heights)).all();
  return rowsAt(db, results.flatMap((r) => [r.below, r.above]));
}

/// At most two full blocks per cron round; historical coverage grows honestly.
export async function sampleNetwork(env) {
  const db = env.DB, t = now();
  if (!await reserveBudget(db, "Blockbook", 1, t)) return;
  const tip = await chainHeight(env);
  if (tip < 2) return;
  const cursor = await db.prepare("SELECT v FROM kv WHERE k = 'network:cursor'").first();
  const index = Number(cursor?.v) || 0, step = index % (POINTS - 1) + 1;
  const span = [DAY, 7 * DAY, 30 * DAY, null][Math.floor(index / (POINTS - 1)) % 4];
  const latest = await db.prepare("SELECT height, ts FROM network_samples ORDER BY height DESC LIMIT 1").first();
  // Reuse a broad historical probe already in D1: two adjacent tips are noisy.
  const probe = latest && (await db.prepare("SELECT height, ts FROM network_samples WHERE height <= ? ORDER BY height DESC LIMIT 1").bind(latest.height - 1000).first()
    || await db.prepare("SELECT height, ts FROM network_samples WHERE height < ? ORDER BY height LIMIT 1").bind(latest.height).first());
  const estimate = probe && latest.height > probe.height ? (latest.ts - probe.ts) / (latest.height - probe.height) : 235;
  const blockSeconds = Number.isFinite(estimate) && estimate > 0 ? Math.min(3600, Math.max(10, estimate)) : 235;
  const spanBlocks = span == null ? tip - 1 : Math.max(30, Math.floor(span / blockSeconds));
  const historical = Math.max(1, tip - Math.round(spanBlocks * step / (POINTS - 1)));
  const base = (env.BLOCKBOOK_BASE || "https://blockbook.pearlresearch.ai").replace(/\/$/, "").replace(/\/api\/v2$/, "");
  for (const height of new Set([tip, historical])) {
    if (height !== tip && await db.prepare("SELECT 1 FROM network_samples WHERE height = ?").bind(height).first()) continue;
    if (!await reserveBudget(db, "Blockbook", 1, t)) return;
    const r = await fetch(`${base}/api/v2/block/${height}`, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) throw new Error("upstream");
    const o = JSON.parse(await readCapped(r, MAX_BODY)), difficulty = Number(o.difficulty);
    if (!Number.isSafeInteger(o.time) || o.time <= 0 || !Number.isFinite(difficulty) || difficulty <= 0 || (o.height != null && o.height !== height)) throw new Error("upstream");
    await db.prepare("INSERT INTO network_samples (height, ts, difficulty, sampled_at) VALUES (?, ?, ?, ?) ON CONFLICT(height) DO UPDATE SET ts = excluded.ts, difficulty = excluded.difficulty, sampled_at = excluded.sampled_at").bind(height, o.time, difficulty, t).run();
  }
  await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('network:cursor', ?, ?)").bind(String(index + 1), t).run();
}

/// Sampled history for a span: each point with the hashrate and block time of the WINDOW blocks
/// behind it, interpolated between the samples either side of that block (which may lie before the
/// span). Shared for a minute.
export async function networkHistory(env, span = "7d", ctx) {
  span = ({ h24: "24h", d7: "7d", d30: "30d" })[span] || span;
  if (!["24h", "7d", "30d", "all"].includes(span)) return json({ ok: false, error: "bad span" }, 400);
  return cached(`network-history-v2/${span}`, 60, ctx, async () => {
    const seconds = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY }[span];
    const from = seconds ? now() - seconds : 0;
    const picked = await spanSamples(env.DB, from);
    const behind = await bracketing(env.DB, picked.map((p) => p.height - WINDOW));
    const points = rollingSeries(picked, behind), first = points[0], last = points.at(-1);
    return { ok: true, source: "blockbook", span, window: WINDOW, points, avgBlockTime: points.length >= 2 && last.ts > first.ts ? (last.ts - first.ts) / Math.max(last.height - first.height, 1) : null,
      firstHeight: first?.height ?? null, lastHeight: last?.height ?? null, sampled: true };
  });
}
