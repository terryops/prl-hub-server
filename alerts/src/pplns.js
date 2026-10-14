// Public pool work and attributed block counters only; no miner credentials.
import { now } from "./http.js";

const DAY = 86400, MIN_WINDOW = 5 * DAY, KEEP = 7 * DAY, MAX_GAP = 900;
const key = (id) => `public:pplns:${id}`;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function pplnsPoint(snapshot, row) {
  const payout = row.payouts?.find((p) => !p.solo && p.scheme?.trim().toUpperCase() === "PPLNS");
  const unit = snapshot.network?.prlPerTHDay;
  if (snapshot.stale || row.solo || !payout || !row.id || !row.name ||
      !finite(snapshot.ts) || snapshot.ts <= 0 || !finite(row.hashrate) || row.hashrate < 0 ||
      !Number.isSafeInteger(row.lifetimeBlocks) || row.lifetimeBlocks < 0 ||
      !finite(unit) || unit <= 0 || !finite(snapshot.network?.reward) || snapshot.network.reward <= 0 ||
      !finite(payout.fee) || payout.fee < 0 || payout.fee > 100) return null;
  return { ts: snapshot.ts, hashPH: row.hashrate / 1e15, unit: unit * 1000,
    reward: snapshot.network.reward, fee: payout.fee, blocks: row.lifetimeBlocks };
}

const validPoint = (p) => p && finite(p.ts) && p.ts > 0 && finite(p.hashPH) && p.hashPH >= 0 &&
  finite(p.unit) && p.unit > 0 && finite(p.reward) && p.reward > 0 &&
  finite(p.fee) && p.fee >= 0 && p.fee <= 100 && Number.isSafeInteger(p.blocks) && p.blocks >= 0;
const validSegment = (s) => s && finite(s.start) && s.start > 0 && finite(s.end) && s.end > s.start &&
  s.end - s.start <= 3600 && finite(s.netPRL) && s.netPRL >= 0 && finite(s.expectedPRL) && s.expectedPRL >= 0 &&
  Number.isSafeInteger(s.blocks) && s.blocks >= 0 && Number.isSafeInteger(s.samples) && s.samples > 0;
const validHistory = (h) => h && typeof h.id === "string" && typeof h.pool === "string" && validPoint(h.last) &&
  Array.isArray(h.segments) && h.segments.length <= 200 && h.segments.every((s, i) =>
    validSegment(s) && (!i || s.start === h.segments[i - 1].end)) &&
  (!h.segments.length || h.segments.at(-1).end === h.last.ts);

export function extendPPLNSHistory(previous, id, pool, point) {
  if (!validPoint(point)) throw new Error("invalid_pplns_point");
  const empty = () => ({ id, pool, last: point, segments: [] });
  if (!validHistory(previous) || previous.id !== id || previous.pool !== pool) return empty();
  const last = previous.last, dt = point.ts - last.ts;
  if (dt <= 0) return previous; // Cached reads and concurrent callers cannot count the same work twice.
  if (dt > MAX_GAP || point.blocks < last.blocks) return empty();
  const blocks = point.blocks - last.blocks;
  const netPRL = blocks * (last.reward + point.reward) / 2 * (1 - (last.fee + point.fee) / 200);
  const expectedPRL = (last.hashPH * last.unit + point.hashPH * point.unit) / 2 * dt / DAY;
  if (!finite(netPRL) || !finite(expectedPRL)) return empty();
  const segments = previous.segments.filter((s) => s.end > point.ts - KEEP).map((s) => ({ ...s }));
  const tail = segments.at(-1);
  if (tail && point.ts - tail.start <= 3600) {
    tail.end = point.ts; tail.netPRL += netPRL; tail.expectedPRL += expectedPRL;
    tail.blocks += blocks; tail.samples++;
  } else segments.push({ start: last.ts, end: point.ts, netPRL, expectedPRL, blocks, samples: 1 });
  return { id, pool, last: point, segments };
}

export function pplnsMeasurement(history, t = now()) {
  if (!validHistory(history) || !history.segments.length) return null;
  const end = history.last.ts, start = history.segments[0].start;
  if (end - start < MIN_WINDOW || end - start > KEEP + 3600 || end > t + 60 || end < t - 1800) return null;
  const sum = (field) => history.segments.reduce((total, s) => total + s[field], 0);
  const netPRL = sum("netPRL"), expectedPRL = sum("expectedPRL");
  if (!finite(netPRL) || !finite(expectedPRL) || expectedPRL <= 0) return null;
  return { id: history.id, pool: history.pool, scheme: "PPLNS", start, end, netPRL, expectedPRL,
    estimated: true, sampleCount: sum("samples"), blocksSample: sum("blocks"), theoryBasis: "public_pool_work" };
}

export function validPPLNSMeasurement(o, t = now()) {
  return !!o && typeof o.id === "string" && typeof o.pool === "string" && o.scheme === "PPLNS" &&
    o.theoryBasis === "public_pool_work" && o.estimated === true &&
    finite(o.start) && o.start > 0 && finite(o.end) && o.end - o.start >= MIN_WINDOW && o.end - o.start <= KEEP + 3600 &&
    o.end <= t + 60 && o.end >= t - 1800 && finite(o.netPRL) && o.netPRL >= 0 &&
    finite(o.expectedPRL) && o.expectedPRL > 0 && Number.isSafeInteger(o.sampleCount) && o.sampleCount > 0 &&
    Number.isSafeInteger(o.blocksSample) && o.blocksSample >= 0 && Number.isFinite((1 - o.netPRL / o.expectedPRL) * 100);
}

async function histories(db, rows) {
  const keys = [...new Set(rows.filter((r) => !r.solo && r.payouts?.some((p) => p.scheme === "PPLNS" && !p.solo)).map((r) => key(r.id)))];
  if (!keys.length) return new Map();
  const { results } = await db.prepare(`SELECT k,v FROM kv WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
  return new Map(results.flatMap(({ k, v }) => { try { return [[k, JSON.parse(v)]]; } catch { return []; } }));
}

export async function recordPPLNSSnapshot(db, snapshot) {
  if (snapshot.stale) return;
  const stored = await histories(db, snapshot.rows), writes = [];
  for (const row of snapshot.rows) {
    const point = pplnsPoint(snapshot, row);
    if (!point) continue;
    const previous = stored.get(key(row.id)), next = extendPPLNSHistory(previous, row.id, row.name, point);
    if (next !== previous) writes.push(db.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
      .bind(key(row.id), JSON.stringify(next), snapshot.ts));
  }
  if (writes.length) await db.batch(writes);
}

export async function readPPLNSMeasurements(db, rows, t = now()) {
  return [...(await histories(db, rows)).values()].flatMap((h) => {
    const measurement = pplnsMeasurement(h, t);
    return measurement && validPPLNSMeasurement(measurement, t) ? [measurement] : [];
  });
}
