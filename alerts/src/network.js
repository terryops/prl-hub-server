import { chainHeight } from "./chain.js";
import { readCapped, UA, MAX_BODY, TIMEOUT_MS } from "./pools.js";
import { reserveBudget } from "./poolstats.js";
import { now, webJson as json } from "./http.js";

const WORK = 2 ** 48; // hashes per unit of Pearl difficulty
const DAY = 86400; // seconds
const POINTS = 28; // native sampling density per backfill window
const MAX_POINTS = 256; // bounded response, including window endpoints

/// Native ChainHistory.blockTimes, including its adaptive ±2…5 neighbourhood.
export function measuredSeries(samples) {
  let k = 2;
  while (k < 5) {
    const mid = Math.floor(samples.length / 2), lo = Math.max(0, mid - k), hi = Math.min(samples.length - 1, mid + k);
    if (samples.length && samples[hi].height - samples[lo].height >= 40) break;
    k++;
  }
  return samples.map((s, i) => {
    const lo = samples[Math.max(0, i - k)], hi = samples[Math.min(samples.length - 1, i + k)];
    const dh = hi.height - lo.height, dt = hi.ts - lo.ts;
    const blockTime = samples.length >= 2 && dh > 0 && dt > 0 ? dt / dh : null;
    return { ...s, blockTime, hashrate: blockTime ? s.difficulty * WORK / blockTime : null };
  });
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

export async function networkHistory(env, span = "7d") {
  span = ({ h24: "24h", d7: "7d", d30: "30d" })[span] || span;
  if (!["24h", "7d", "30d", "all"].includes(span)) return json({ ok: false, error: "bad span" }, 400);
  const seconds = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY }[span];
  const from = seconds ? now() - seconds : 0;
  const bounds = await env.DB.prepare("SELECT MIN(ts) AS first, MAX(ts) AS last FROM network_samples WHERE ts >= ?").bind(from).first();
  const bucket = Math.max(1, Math.ceil(((bounds?.last || 0) - (bounds?.first || 0)) / (MAX_POINTS - 2)));
  const { results } = await env.DB.prepare(`SELECT height, ts, difficulty FROM network_samples WHERE ts >= ? AND height IN (
    SELECT MIN(height) FROM network_samples WHERE ts >= ? GROUP BY CAST(ts / ? AS INTEGER)
    UNION SELECT MAX(height) FROM network_samples WHERE ts >= ?) ORDER BY height`)
    .bind(from, from, bucket, from).all();
  const points = measuredSeries(results), first = points[0], last = points.at(-1);
  return json({ ok: true, source: "blockbook", span, points, avgBlockTime: points.length >= 2 && last.ts > first.ts ? (last.ts - first.ts) / Math.max(last.height - first.height, 1) : null,
    firstHeight: first?.height ?? null, lastHeight: last?.height ?? null, sampled: true });
}
