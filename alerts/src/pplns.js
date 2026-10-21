// Public pool work and attributed block counters only; no miner credentials.
import { now } from "./http.js";

// MIN_WINDOW is observed time, not span: holes left by gaps do not count towards it.
// The PPLNS cost estimate keeps its seven-day span; block luck reads the full fortnight.
const DAY = 86400, MIN_WINDOW = 5 * DAY, FEE_SPAN = 7 * DAY, KEEP = 14 * DAY, MAX_GAP = 1800, MAX_SEGMENTS = 400;
/// A cost estimate also needs the window's work to be worth this many blocks. Luck over N
/// expected blocks swings about ±1/√N: ±10% at 100, while 4 blocks read as −24%.
export const MIN_PPLNS_BLOCKS = 100;
/// Block luck is published per window once 90% of it has been observed. A day of ~20
/// blocks swings ±20% on luck alone; a week of the same pool is within ~8%.
export const LUCK_WINDOWS = { "24h": DAY, "7d": 7 * DAY, "14d": 14 * DAY };
const COVERAGE = 0.9;
const key = (id) => `public:pplns:${id}`;
// Every row's windows, computed when a snapshot is recorded, so a read never parses history.
const SUMMARY_KEY = "public:pool-luck:v1";
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/// The contract a pool's own luck reaches: PPLNS, PROP or one the source leaves unnamed.
/// PPS contracts and SOLO are paid on other terms.
export function sharedPayout(row) {
  if (!row || row.solo) return null;
  return row.payouts?.find((p) => !p.solo && !/^(PPS|FPPS|SOLO)/i.test(p.scheme?.trim() || "")) || null;
}

/// Pools that name no scheme but were checked on chain to pay out the blocks they find, so a
/// cost estimate means what it means for PPLNS. PearlHash, 2026-10-20: each payout round, about
/// every two hours, is a whole number of full block rewards, and the pool keeps no reserve.
const BLOCK_SHARING = new Set(["https://pearlhash.xyz/"]);

/// Whether a payout gets a cost estimate: PPLNS or PROP by name, or an unnamed scheme on a pool
/// checked to pay out its blocks. Both pay out the blocks found, so luck is part of the cost.
export function costEstimated(row, payout) {
  if (!row || row.solo || !payout || payout.solo) return false;
  const name = payout.scheme?.trim().toUpperCase() || "";
  return name === "PPLNS" || name === "PROP" || (!name && BLOCK_SHARING.has(row.id));
}

export function pplnsPoint(snapshot, row) {
  const payout = sharedPayout(row);
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
// grossPRL and work arrived with the luck windows; older segments derive them (see luckWindows).
const optional = (v) => v === undefined || finite(v) && v >= 0;
const validSegment = (s) => s && finite(s.start) && s.start > 0 && finite(s.end) && s.end > s.start &&
  s.end - s.start <= 3600 && finite(s.netPRL) && s.netPRL >= 0 && finite(s.expectedPRL) && s.expectedPRL >= 0 &&
  optional(s.grossPRL) && optional(s.work) &&
  Number.isSafeInteger(s.blocks) && s.blocks >= 0 && Number.isSafeInteger(s.samples) && s.samples > 0;
const validHistory = (h) => h && typeof h.id === "string" && typeof h.pool === "string" && validPoint(h.last) &&
  Array.isArray(h.segments) && h.segments.length <= MAX_SEGMENTS && h.segments.every((s, i) =>
    validSegment(s) && (!i || s.start >= h.segments[i - 1].end)) &&
  (!h.segments.length || h.segments.at(-1).end <= h.last.ts);

/// Pools the overview has renamed (old → new). A history kept under the old name carries on
/// under the new one; a plain name change would otherwise restart it from nothing.
const RENAMED = { Pearlski: "Jetski" };
const currentName = (name) => (Object.hasOwn(RENAMED, name) ? RENAMED[name] : name);

export function extendPPLNSHistory(previous, id, pool, point) {
  if (!validPoint(point)) throw new Error("invalid_pplns_point");
  if (!validHistory(previous) || previous.id !== id || currentName(previous.pool) !== pool) return { id, pool, last: point, segments: [] };
  // Renamed: the same history under the new name, so even a cached read rewrites it once.
  if (previous.pool !== pool) previous = { ...previous, pool };
  const last = previous.last, dt = point.ts - last.ts;
  if (dt <= 0) return previous; // Cached reads and concurrent callers cannot count the same work twice.
  const segments = previous.segments.filter((s) => s.end > point.ts - KEEP).slice(1 - MAX_SEGMENTS).map((s) => ({ ...s }));
  // A gap, a counter that went back or an implausible jump leaves a hole: that interval's
  // blocks and its expected output are both left out, and the rest of the window stays.
  const hole = () => ({ id, pool, last: point, segments });
  if (dt > MAX_GAP || point.blocks < last.blocks) return hole();
  const blocks = point.blocks - last.blocks, reward = (last.reward + point.reward) / 2;
  const grossPRL = blocks * reward, netPRL = grossPRL * (1 - (last.fee + point.fee) / 200);
  const expectedPRL = (last.hashPH * last.unit + point.hashPH * point.unit) / 2 * dt / DAY;
  const work = (last.hashPH + point.hashPH) / 2 * dt / DAY; // PH·days
  if (!finite(netPRL) || !finite(expectedPRL) || !finite(work)) return hole();
  // Far more blocks than the pool's work could find means the counter changed source.
  if (blocks > Math.max(5, 10 * expectedPRL / reward)) return hole();
  const tail = segments.at(-1);
  if (tail && tail.end === last.ts && point.ts - tail.start <= 3600 && finite(tail.work)) {
    tail.end = point.ts; tail.netPRL += netPRL; tail.grossPRL += grossPRL; tail.expectedPRL += expectedPRL;
    tail.work += work; tail.blocks += blocks; tail.samples++;
  } else segments.push({ start: last.ts, end: point.ts, netPRL, grossPRL, expectedPRL, work, blocks, samples: 1 });
  return { id, pool, last: point, segments };
}

/// The cost estimate leaves block luck out. The chain says how many blocks the pool found for
/// the work it displayed (fee, luck and lost work together); the pool's own block list says
/// how much work those blocks took (Σ effort, each block's shares ÷ difficulty), so its luck
/// is blocks ÷ Σ effort. Dividing that out leaves the fee and the work the pool loses: what a
/// miner gives up in the long run. Pools that publish no per-block effort get no estimate.
export function pplnsMeasurement(history, t = now(), effort = null) {
  if (!validHistory(history) || !validEffort(effort)) return null;
  const end = history.last.ts, daily = dailyPart(effort, end);
  const segments = history.segments.filter((s) => s.end > end - FEE_SPAN && s.start >= (daily ? daily.from : effort.since));
  if (!segments.length) return null;
  const start = segments[0].start;
  const sum = (field) => segments.reduce((total, s) => total + s[field], 0);
  const covered = segments.reduce((total, s) => total + s.end - s.start, 0);
  if (covered < MIN_WINDOW || end - start > FEE_SPAN + 3600 || end > t + 60 || end < t - 1800) return null;
  const netPRL = sum("netPRL"), expectedPRL = sum("expectedPRL");
  if (!finite(netPRL) || !finite(expectedPRL) || expectedPRL <= 0) return null;
  const expectedBlocks = expectedPRL / history.last.reward;
  if (!(expectedBlocks >= MIN_PPLNS_BLOCKS)) return null;
  // The pool's blocks inside observed time: holes drop the pool's blocks as they drop the chain's.
  let i = 0, poolBlocks = 0, orphans = 0, work = 0;
  for (const [, ts, e, orphan] of effort.blocks) {
    while (i < segments.length && segments[i].end < ts) i++;
    if (i === segments.length) break;
    if (ts <= segments[i].start) continue;
    poolBlocks++; orphans += orphan; work += e;
  }
  if (daily) {
    // Daily totals also count blocks found while we saw nothing; luck is read as their mean effort,
    // which those do not tilt, but most of the time must have been seen.
    const seen = segments.reduce((total, s) => total + Math.max(0, Math.min(s.end, daily.until) - Math.max(s.start, daily.from)), 0);
    if (seen < (daily.until - daily.from) * .9) return pplnsMeasurement(history, t, { since: effort.since, blocks: effort.blocks });
    poolBlocks += daily.blocks; orphans += daily.orphans; work += daily.work;
  }
  // The pool's list must describe the blocks the chain credits it with.
  const chainBlocks = sum("blocks"), kept = poolBlocks - orphans;
  if (!poolBlocks || !(work > 0) || Math.abs(chainBlocks - kept) > Math.max(3, kept * .05)) return null;
  // Luck out: × the pool's mean effort per block (its blocks ÷ the work they took, inverted).
  // Its own shares above the hashrate it displays mean the display runs low: the shares are the
  // work its miners did, so the baseline becomes the blocks the chain saw plus orphans
  // (fee and orphans remain). Below it, miners did work that never became shares, and the
  // display stays the baseline.
  const ratio = netPRL / expectedPRL * Math.min(work / poolBlocks, expectedBlocks / (chainBlocks + orphans));
  if (!finite(ratio)) return null;
  return { id: history.id, pool: history.pool, scheme: "PPLNS", start, end, netPRL, expectedPRL, expectedBlocks,
    poolBlocks, orphans, work, luck: poolBlocks / work, ratio,
    estimated: true, sampleCount: sum("samples"), blocksSample: chainBlocks, covered, theoryBasis: "pool_effort" };
}

export function validPPLNSMeasurement(o, t = now()) {
  return !!o && typeof o.id === "string" && typeof o.pool === "string" && o.scheme === "PPLNS" &&
    o.theoryBasis === "pool_effort" && o.estimated === true &&
    finite(o.start) && o.start > 0 && finite(o.end) && o.end - o.start >= MIN_WINDOW && o.end - o.start <= FEE_SPAN + 3600 &&
    o.end <= t + 60 && o.end >= t - 1800 && finite(o.netPRL) && o.netPRL >= 0 &&
    finite(o.expectedPRL) && o.expectedPRL > 0 && finite(o.expectedBlocks) && o.expectedBlocks >= MIN_PPLNS_BLOCKS &&
    Number.isSafeInteger(o.poolBlocks) && o.poolBlocks > 0 && finite(o.work) && o.work > 0 &&
    finite(o.ratio) && o.ratio >= 0 && o.ratio <= 2 &&
    Number.isSafeInteger(o.sampleCount) && o.sampleCount > 0 &&
    Number.isSafeInteger(o.blocksSample) && o.blocksSample >= 0;
}

// ── Each pool's own block list: when it found each block and the work that took ──────────

/// Stored per pool as [height, time, effort, orphan 0/1], oldest first. `since` is the time
/// from which the list is complete; a week of it is needed for an estimate.
const EFFORT_KEEP = 8 * DAY, EFFORT_MAX = 3000;
const effortKey = (id) => `public:effort:${id}`;
/// Optional `days`: a pool's own daily totals, [UTC day start, blocks, work (blocks × effort), orphans].
const validDays = (days) => Array.isArray(days) && days.length <= 40 && days.every((d, i) => Array.isArray(d) &&
  Number.isSafeInteger(d[0]) && d[0] > 0 && d[0] % DAY === 0 && Number.isSafeInteger(d[1]) && d[1] >= 0 &&
  finite(d[2]) && d[2] >= 0 && Number.isSafeInteger(d[3]) && d[3] >= 0 && d[3] <= d[1] && (!i || d[0] > days[i - 1][0]));
const validEffort = (e) => !!e && finite(e.since) && Array.isArray(e.blocks) && e.blocks.length <= EFFORT_MAX &&
  e.blocks.every((b, i) => Array.isArray(b) && Number.isSafeInteger(b[0]) && b[0] > 0 && finite(b[1]) && b[1] > 0 &&
    finite(b[2]) && b[2] >= 0 && (b[3] === 0 || b[3] === 1) && (!i || b[0] > e.blocks[i - 1][0] && b[1] >= e.blocks[i - 1][1])) &&
  (e.days === undefined || validDays(e.days)) && (e.cursor === undefined || Number.isSafeInteger(e.cursor) && e.cursor > 0);

/// While a pool's block list is shorter than the week, its own daily totals stand in for the whole
/// UTC days before it: from the week's first whole day through the day the list starts, that day
/// counted as its total less the blocks the list holds for it. The day must be over (its total final)
/// and every day present; otherwise the list is measured alone.
function dailyPart(effort, end) {
  if (!effort.days?.length || !effort.blocks.length || effort.since <= end - FEE_SPAN) return null;
  const until = effort.blocks[0][1], first = Math.floor(until / DAY) * DAY, from = Math.ceil((end - FEE_SPAN) / DAY) * DAY;
  if (first + DAY > end - 3600 || from > first) return null;
  const byDay = new Map(effort.days.map((d) => [d[0], d]));
  let blocks = 0, work = 0, orphans = 0;
  for (let day = from; day <= first; day += DAY) {
    if (!byDay.has(day)) return null;
    let [, n, w, o] = byDay.get(day);
    if (day === first) for (const b of effort.blocks) if (b[1] < first + DAY) { n--; w -= b[2]; o -= b[3]; }
    if (n < 0 || o < 0 || o > n || w < -.05 * Math.max(1, n)) return null;
    blocks += n; work += Math.max(0, w); orphans += o;
  }
  return { from, until, blocks, work, orphans };
}

/// Orphan rate: the share of a pool's own blocks over the last week that lost the race, from its
/// list (complete from `since`) and, while that is short of the week, its daily totals for the
/// whole days before it. Our own sampling plays no part, so holes in it do not thin the count.
/// Published from 20 blocks over at least a day.
export const MIN_ORPHAN_BLOCKS = 20;
export function orphanWindow(effort, t = now()) {
  if (!validEffort(effort) || !effort.blocks.length) return null;
  const daily = dailyPart(effort, t), start = daily ? daily.from : Math.max(effort.since, t - FEE_SPAN);
  let blocks = daily ? daily.blocks : 0, orphans = daily ? daily.orphans : 0;
  for (const [, ts, , orphan] of effort.blocks) if (ts >= start) { blocks++; orphans += orphan; }
  return blocks >= MIN_ORPHAN_BLOCKS && t - start >= DAY ? { start, end: t, blocks, orphans, source: "pool" } : null;
}
export const validOrphans = (o, t = now()) => !!o && finite(o.start) && o.start > 0 && finite(o.end) &&
  o.end - o.start >= DAY && o.end - o.start <= FEE_SPAN + 60 && o.end <= t + 60 && o.end >= t - 1800 &&
  Number.isSafeInteger(o.blocks) && o.blocks >= MIN_ORPHAN_BLOCKS &&
  Number.isSafeInteger(o.orphans) && o.orphans >= 0 && o.orphans <= o.blocks &&
  (o.source === undefined || o.source === "pool" || o.source === "chain");

// ── Orphans the chain saw, for every pool the explorer can name ─────────────────────────────

/// lordofpearls' node reports the blocks it saw lose the race: `orphans.recent` in `/api/public`,
/// the last 30 with their miner and, when it knows it, the pool. Kept for a week and a day next to
/// each pool's chain block counter (an hourly point), they give an orphan rate for every pool whose
/// blocks the explorer credits. A node does not see every orphan: on 2026-10-20 it had none of
/// Pearl Fortune's 1 or HeroMiners' 3 that their own lists show. So a pool gets the higher of the
/// two rates, and the window says which source it came from.
const CHAIN_KEY = "public:chain-orphans:v1", CHAIN_KEEP = 8 * DAY, CHAIN_STEP = 3600;
/// Payout addresses the explorer leaves unnamed, checked against the pool's own block list (as
/// POOL_ADDRESSES in overview.js).
const CHAIN_ADDRESSES = { prl1pgr2znrzz8nwu2lrw4phrzaqqa8ukt76qsqc29wxgcwgalanur7zsk8w070: "https://pearl.jetskipool.ai/" };
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const validChain = (c) => !!c && finite(c.since) && Array.isArray(c.orphans) && c.orphans.length <= 2000 &&
  c.orphans.every((o) => Array.isArray(o) && typeof o[0] === "string" && finite(o[1]) && Number.isSafeInteger(o[2]) &&
    (o[3] === null || typeof o[3] === "string")) &&
  !!c.counters && typeof c.counters === "object" && Object.values(c.counters).every((pts) => Array.isArray(pts) &&
    pts.length <= 400 && pts.every((p, i) => Array.isArray(p) && finite(p[0]) && Number.isSafeInteger(p[1]) && p[1] >= 0 &&
      (!i || p[0] > pts[i - 1][0] && p[1] >= pts[i - 1][1])));

/// Adds what the explorer reports now: its orphan list (a gap since the last read, when nothing
/// overlaps, starts the list again) and each named pool's block counter, at most once an hour.
/// `seed(id, row)` gives earlier counter points for a pool seen for the first time.
export function extendChainOrphans(previous, recent, rows, t, seed = () => []) {
  const prev = validChain(previous) ? previous : null;
  const byHost = new Map(rows.filter((r) => !r.solo && r.id).map((r) => [hostOf(r.id), r.id]));
  const owner = (o) => byHost.get(hostOf(o?.pool?.url)) ?? (Object.hasOwn(CHAIN_ADDRESSES, o?.miner || "") ? byHost.get(hostOf(CHAIN_ADDRESSES[o.miner])) ?? null : null);
  const fresh = (Array.isArray(recent) ? recent : []).flatMap((o) => typeof o?.hash === "string" && finite(o.detected_at) &&
    Number.isSafeInteger(o.height) ? [[o.hash, o.detected_at, o.height, owner(o)]] : []).sort((a, b) => a[1] - b[1]);
  let orphans = prev ? prev.orphans : [], since = prev ? prev.since : t;
  if (fresh.length) {
    const known = new Set(orphans.map((o) => o[0]));
    if (!prev || !fresh.some((o) => known.has(o[0])) && fresh[0][1] > (orphans.at(-1)?.[1] ?? 0)) { orphans = fresh; since = fresh[0][1]; }
    else orphans = [...orphans, ...fresh.filter((o) => !known.has(o[0]))].sort((a, b) => a[1] - b[1]);
  }
  orphans = orphans.filter((o) => o[1] >= t - CHAIN_KEEP);
  const counters = {};
  for (const r of rows) {
    if (r.solo || !r.id || !Number.isSafeInteger(r.lifetimeBlocks) || r.lifetimeBlocks < 0) continue;
    let pts = prev?.counters[r.id] ?? seed(r.id, r).filter((p) => p[0] < t && p[1] <= r.lifetimeBlocks);
    // A counter that went back changed source: start that pool again.
    if (pts.length && r.lifetimeBlocks < pts.at(-1)[1]) pts = [];
    if (!pts.length || t - pts.at(-1)[0] >= CHAIN_STEP) pts = [...pts, [t, r.lifetimeBlocks]];
    counters[r.id] = pts.filter((p) => p[0] >= t - CHAIN_KEEP);
  }
  const next = { since: Math.max(since, t - CHAIN_KEEP), orphans, counters };
  return validChain(next) ? next : prev;
}

/// A pool's orphan rate on chain over the last week: the orphans the node saw ÷ the blocks the
/// chain credits the pool with plus those orphans, from its first counter point inside the week.
export function chainOrphanWindow(chain, id, t = now()) {
  if (!validChain(chain)) return null;
  const pts = chain.counters[id];
  if (!pts?.length) return null;
  const from = Math.max(t - FEE_SPAN, chain.since), first = pts.find((p) => p[0] >= from), last = pts.at(-1);
  if (!first || last[0] - first[0] < DAY) return null;
  const orphans = chain.orphans.filter((o) => o[3] === id && o[1] > first[0] && o[1] <= t).length;
  const blocks = last[1] - first[1] + orphans;
  return blocks >= MIN_ORPHAN_BLOCKS ? { start: first[0], end: t, blocks, orphans, source: "chain" } : null;
}

/// The higher of the two rates; on a tie, the pool's own list.
const worseOrphans = (own, chain) => !own ? chain : !chain ? own : chain.orphans * own.blocks > own.orphans * chain.blocks ? chain : own;

/// Earlier counter points: from a PPLNS history (its last counter, less the blocks of the segments
/// after each point) or, for a pool without one, the explorer's own count of its last 24 hours.
/// The walk back stops at the first hole (a gap, or a counter that went back or jumped): the blocks
/// found in it are unknown, and taking them as none would put every earlier point too high.
export function counterSeed(history, row, t) {
  if (!validHistory(history)) {
    const day = row?.source === "lordofpearls" && row.sampleDays === 1 && Number.isSafeInteger(row.blocksSample) ? row.blocksSample : null;
    return day != null && row.lifetimeBlocks - day >= 0 ? [[t - DAY, row.lifetimeBlocks - day]] : [];
  }
  const pts = [[history.last.ts, history.last.blocks]];
  let blocks = history.last.blocks;
  for (let i = history.segments.length - 1; i >= 0; i--) {
    const s = history.segments[i];
    if (s.end !== pts[0][0] || blocks - s.blocks < 0) break;
    blocks -= s.blocks;
    pts.unshift([s.start, blocks]);
  }
  // Hourly points are enough: each one at least an hour after the last one kept, and the latest.
  const hourly = [];
  for (const p of pts) if (!hourly.length || p[0] - hourly.at(-1)[0] >= CHAIN_STEP) hourly.push(p);
  if (hourly.at(-1) !== pts.at(-1)) hourly.push(pts.at(-1));
  return hourly;
}

const amount = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
/// One block, or null when anything is missing: a list with a block we cannot read is not used.
function block(height, time, effort, orphan) {
  const h = Number(height), ts = amount(time), e = amount(effort);
  return Number.isSafeInteger(h) && h > 0 && ts > 0 && e != null ? [h, ts, e, orphan ? 1 : 0] : null;
}
const shares = (diff, done) => amount(diff) > 0 && amount(done) != null ? amount(done) / amount(diff) : null;
/// "hash:time:difficulty:shares:…" entries, each followed by its height. `read` returns a
/// block, false for one that is not the pool's (a solo block), or null when it cannot read it.
function pairs(list, read) {
  if (!Array.isArray(list) || list.length % 2) return null;
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    const b = typeof list[i] === "string" ? read(list[i].split(":"), list[i + 1]) : null;
    if (b === null) return null;
    if (b) out.push(b);
  }
  return out;
}
function objects(list, read) {
  if (!Array.isArray(list)) return null;
  const out = list.map(read);
  return out.includes(null) ? null : out.filter(Boolean);
}

const fortunePage = (e) => e.cursor ?? Math.floor(e.blocks.length / 20) + 1;
/// Pools whose block lists carry each block's effort, checked 2026-10-20 against the chain:
/// each list's block count over the week matched the blocks the explorer credits the pool with.
export const EFFORT_SOURCES = {
  // 20 blocks a page, newest first, rejected ones included. created_at carries its offset; effort is
  // shares ÷ difficulty.
  "https://pearlfortune.org/": {
    budget: "Pearl Fortune",
    latest: "https://pearlfortune.org/api/v1/blocks?page=1",
    // The page at our count, at first: new blocks only push older ones down, so it holds our oldest block
    // or one above it. Rejected blocks are on the pool's pages but not in our list, so it can fall short;
    // after each page the next one down, which never skips a block for the same reason.
    older: (e) => `https://pearlfortune.org/api/v1/blocks?page=${fortunePage(e)}`,
    next: (e) => fortunePage(e) + 1,
    parse: (o) => objects(o?.data?.blocks, (b) => /reject|fail|invalid/i.test(b?.submit_status || "") ? false :
      block(b?.block_height, Date.parse(b?.created_at) / 1000, b?.effort, /orphan/i.test(b?.submit_status || ""))),
  },
  // The last 100 blocks: hash:time:difficulty:shares:orphaned:reward:solo. An orphan's
  // shares move to the next block, so its effort is 0 and the work is still counted once.
  "https://pearl.luckypool.io/": {
    budget: "Lucky Pool",
    latest: "https://pearl.luckypool.io/api/stats",
    parse: (o) => pairs(o?.pool?.blocks, (p, h) => p.length < 5 ? null : p[6] === "1" ? false :
      block(h, p[1], shares(p[2], p[3]), p[4] === "1")),
    // 31 UTC days: date (the day's last second), block, effort (Σ shares ÷ Σ difficulty), orphan, solo.
    // For whole days it equals the block list (2026-10-17 to 19: 31, 25, 28 blocks, same effort).
    // A day with solo blocks is left out, which leaves a gap the week cannot cross.
    days: "https://pearl.luckypool.io/api/block-stats",
    parseDays: (o) => objects(o?.data, (d) => {
      const start = Number(d?.date) + 1 - DAY, n = d?.block, e = amount(d?.effort), o = d?.orphan ?? 0;
      if (Number(d?.solo ?? 0) !== 0) return false;
      return Number.isSafeInteger(start) && start > 0 && start % DAY === 0 && Number.isSafeInteger(n) && n >= 0 && e != null &&
        Number.isSafeInteger(o) && o >= 0 && o <= n ? [start, n, n * e, o] : null;
    }),
  },
  // hash:time:difficulty:shares:score:hash:status:reward:address:region:scheme. /api/stats has
  // the newest blocks; get_blocks?height=H the ten before H.
  "https://pearl.herominers.com/": {
    budget: "HeroMiners",
    latest: "https://pearl.herominers.com/api/stats",
    older: (e) => `https://pearl.herominers.com/api/get_blocks?height=${e.cursor ?? e.blocks[0][0]}`,
    // Below the lowest block that page held, solo ones included: ten solo blocks in a row would
    // otherwise be asked for again every round.
    next: (e, o) => {
      const heights = Array.isArray(o) ? o.filter((_, i) => i % 2).map(Number).filter((h) => Number.isSafeInteger(h) && h > 0) : [];
      const low = heights.length ? Math.min(...heights) : null;
      return low && low < (e.cursor ?? e.blocks[0][0]) ? low : null;
    },
    parse: (o) => pairs(Array.isArray(o) ? o : o?.pool?.blocks, (p, h) => p.length < 7 ? null : /solo/i.test(p[10] || "") ? false :
      block(h, p[1], shares(p[2], p[3]), /orphan/i.test(p[6]))),
  },
  // The last 50 blocks, each with its effort and lifecycle ("orphan" when it lost the race).
  "https://pearl.jetskipool.ai/": {
    budget: "Jetski",
    latest: "https://pearl.jetskipool.ai/api/stats",
    parse: (o) => objects(o?.recent_blocks_found, (b) => block(b?.height, b?.time, b?.effort, /orphan/i.test(b?.lifecycle_status || ""))),
  },
};

/// Adds a list to the stored one. The newest list must reach back into what is stored, or
/// blocks between them may be missing and the store starts again from it. An older page
/// extends the store backwards (each source asks only for pages that join on).
export function mergeEfforts(stored, list, t, older = false) {
  if (!Array.isArray(list) || !list.length) return validEffort(stored) ? stored : null;
  const fresh = [...new Map(list.map((b) => [b[0], b])).values()].sort((a, b) => a[0] - b[0]);
  let blocks, since, restarted = false;
  if (!validEffort(stored) || !stored.blocks.length) {
    if (older) return null;
    blocks = fresh; since = fresh[0][1]; restarted = true;
  } else if (older) {
    const oldest = stored.blocks[0][0];
    const before = fresh.filter((b) => b[0] < oldest);
    if (!before.length) return stored;
    blocks = [...before, ...stored.blocks]; since = Math.min(stored.since, before[0][1]);
  } else if (fresh[0][0] > stored.blocks.at(-1)[0]) {
    blocks = fresh; since = fresh[0][1]; restarted = true;
  } else {
    const byHeight = new Map(stored.blocks.map((b) => [b[0], b]));
    for (const b of fresh) byHeight.set(b[0], b);
    blocks = [...byHeight.values()].sort((a, b) => a[0] - b[0]); since = stored.since;
  }
  // A pool that re-dates a block cannot make the list run backwards.
  for (let i = 1; i < blocks.length; i++) if (blocks[i][1] < blocks[i - 1][1]) blocks[i] = [blocks[i][0], blocks[i - 1][1], blocks[i][2], blocks[i][3]];
  blocks = blocks.filter((b) => b[1] >= t - EFFORT_KEEP).slice(-EFFORT_MAX);
  if (!blocks.length) return null;
  const next = { since: Math.max(since, blocks[0][1]), blocks };
  // Daily totals stay with the list whatever happens to it (they are the pool's own, by day).
  if (validDays(stored?.days)) next.days = stored.days.filter((d) => d[0] >= t - EFFORT_KEEP - DAY);
  // Where the backfill goes on from belongs to the list it was worked out for.
  if (!restarted && stored.cursor !== undefined) next.cursor = stored.cursor;
  return validEffort(next) ? next : null;
}

/// Fetches each pool's newest blocks and, while the stored list is short of a week, one older page
/// or the pool's daily totals.
async function refreshEfforts(stored, ids, t, fetchJSON) {
  const out = new Map();
  await Promise.all(ids.map(async (id) => {
    const source = EFFORT_SOURCES[id], before = stored.get(effortKey(id));
    let effort = validEffort(before) ? before : null;
    const short = !!effort?.blocks.length && effort.since > t - FEE_SPAN - 3600, backfill = short && !!source.older;
    const [latest, older, daily] = await Promise.allSettled([fetchJSON(source.latest, source.budget),
      backfill ? fetchJSON(source.older(effort), source.budget) : null,
      short && source.days ? fetchJSON(source.days, source.budget) : null]);
    const oldest = effort?.blocks[0]?.[0];
    if (latest.status === "fulfilled") effort = mergeEfforts(effort, source.parse(latest.value), t);
    // The older page was asked for below the stored list; if the newest list started over, it no longer joins.
    const page = effort && backfill && effort.blocks[0][0] === oldest && older.status === "fulfilled" && older.value ? source.parse(older.value) : null;
    if (page) {
      effort = mergeEfforts(effort, page, t, true) || effort;
      // Read, so the next round asks for the page after it (`before` is the list it was chosen for).
      const cursor = source.next?.(before, older.value);
      if (Number.isSafeInteger(cursor) && cursor > 0) effort = { ...effort, cursor };
    }
    if (effort && short && source.days && daily.status === "fulfilled" && daily.value) {
      const days = source.parseDays(daily.value)?.filter((d) => d[0] >= t - EFFORT_KEEP - DAY);
      if (days?.length && validDays(days)) effort = { ...effort, days };
    }
    out.set(id, effort);
  }));
  return out;
}

/// Block luck per window: the pool's blocks ÷ the blocks its reported work should have found
/// at each moment's difficulty (`ratio`), and what both come to per PH·day. Only segments
/// wholly inside the window count; holes are unobserved time, never zero work.
export function luckWindows(history, t = now()) {
  if (!validHistory(history) || !history.segments.length) return {};
  const { ts: end, fee, unit, reward } = history.last;
  if (end > t + 60 || end < t - 1800) return {};
  const out = {};
  for (const [name, span] of Object.entries(LUCK_WINDOWS)) {
    const segments = history.segments.filter((s) => s.start >= end - span);
    const sum = (f) => segments.reduce((total, s) => total + f(s), 0);
    const covered = sum((s) => s.end - s.start);
    if (covered < span * COVERAGE) continue;
    // Segments from before these fields existed: the pool's fee and the network's yield
    // per PH·day barely move inside the fortnight they can still be part of.
    const gross = sum((s) => s.grossPRL ?? (fee < 100 ? s.netPRL / (1 - fee / 100) : NaN));
    const work = sum((s) => s.work ?? s.expectedPRL / unit), expected = sum((s) => s.expectedPRL);
    if (!finite(gross) || !(work > 0) || !(expected > 0)) continue;
    out[name] = { start: segments[0].start, end, covered, blocks: sum((s) => s.blocks),
      expectedBlocks: expected / reward, ratio: gross / expected,
      grossPerPH: gross / work, theoreticalPerPH: expected / work };
  }
  return out;
}

const validLuck = (w, span, t) => !!w && finite(w.start) && finite(w.end) && w.end > w.start &&
  w.end - w.start <= span + 3600 && w.end <= t + 60 && w.end >= t - 1800 &&
  finite(w.covered) && w.covered >= span * COVERAGE && Number.isSafeInteger(w.blocks) && w.blocks >= 0 &&
  [w.expectedBlocks, w.ratio, w.grossPerPH, w.theoreticalPerPH].every((v) => finite(v) && v >= 0) &&
  w.expectedBlocks > 0 && w.theoreticalPerPH > 0;

// ── PearlHash: its accepted-share rate, recorded to learn what its own numbers mean ───────

/// PearlHash publishes no per-block effort, only `hashrate_diff_5m` in `/api/stats`: its accepted
/// share difficulty per second (an account's value ÷ the pool's equals that account's share of
/// an hourly payout). Its displayed hashrate is that × 2.5755e14 exactly, 8.5% below the 2^48
/// hashes a unit of network difficulty takes. Which of the two is the work that finds blocks
/// shows only over weeks: per UTC day this keeps the observed seconds, the blocks found and the
/// blocks each reading predicts. Owner, 2026-10-20: record it for 2–3 weeks, then decide.
const PEARLHASH = "https://pearlhash.xyz/", PH_KEY = "public:pearlhash-work:v1", PH_DAYS = 60;
const validPHPoint = (p) => !!p && finite(p.ts) && p.ts > 0 && Number.isSafeInteger(p.blocks) && p.blocks >= 0 &&
  finite(p.diffRate) && p.diffRate >= 0 && finite(p.display) && p.display >= 0 && finite(p.difficulty) && p.difficulty > 0;
const validPHDays = (days) => Array.isArray(days) && days.length <= PH_DAYS + 1 && days.every((d, i) => Array.isArray(d) &&
  d.length === 5 && Number.isSafeInteger(d[0]) && d[0] % DAY === 0 && d.slice(1).every((v) => finite(v) && v >= 0) &&
  Number.isSafeInteger(d[2]) && (!i || d[0] > days[i - 1][0]));

/// Adds one observation. Like the PPLNS history, a gap, a counter that went back or an implausible
/// jump leaves the interval out. Per day: [UTC day, seconds, blocks found, blocks predicted by the
/// accepted-share rate at 2^48 hashes a unit, blocks predicted by the displayed hashrate].
export function extendPearlHashWork(previous, point) {
  if (!validPHPoint(point)) return previous;
  const ok = previous && validPHPoint(previous.last) && validPHDays(previous.days);
  const days = ok ? previous.days.filter((d) => d[0] >= Math.floor(point.ts / DAY) * DAY - PH_DAYS * DAY).map((d) => [...d]) : [];
  const last = ok ? previous.last : null, dt = last ? point.ts - last.ts : 0;
  if (last && dt <= 0) return previous;
  if (last && dt <= MAX_GAP && point.blocks >= last.blocks) {
    const difficulty = (last.difficulty + point.difficulty) / 2;
    const accepted = (last.diffRate + point.diffRate) / 2 * dt / difficulty;
    const shown = (last.display + point.display) / 2 * dt / (difficulty * 2 ** 48);
    const blocks = point.blocks - last.blocks;
    if (blocks <= Math.max(5, 10 * Math.max(accepted, shown)) && finite(accepted) && finite(shown)) {
      const day = Math.floor(point.ts / DAY) * DAY;
      if (days.at(-1)?.[0] !== day) days.push([day, 0, 0, 0, 0]);
      const d = days.at(-1);
      d[1] += dt; d[2] += blocks; d[3] += accepted; d[4] += shown;
    }
  }
  return { last: { ts: point.ts, blocks: point.blocks, diffRate: point.diffRate, display: point.display, difficulty: point.difficulty }, days };
}

/// PearlHash's row and network difficulty from the snapshot, its own rate and display from `/api/stats`.
async function recordPearlHash(stored, snapshot, fetchJSON) {
  const row = snapshot.rows.find((r) => r.id === PEARLHASH && !r.solo);
  const difficulty = snapshot.network?.difficulty;
  if (!row || !Number.isSafeInteger(row.lifetimeBlocks) || !finite(difficulty) || difficulty <= 0) return null;
  let o;
  try { o = await fetchJSON("https://pearlhash.xyz/api/stats", "PearlHash"); } catch { return null; }
  const point = { ts: snapshot.ts, blocks: row.lifetimeBlocks, diffRate: amount(o?.hashrate_diff_5m), display: amount(o?.hashrate), difficulty };
  const previous = stored.get(PH_KEY), next = extendPearlHashWork(previous, point);
  return next !== previous ? next : null;
}

const estimatedRows = (rows) => rows.filter((r) => costEstimated(r, sharedPayout(r)) && Object.hasOwn(EFFORT_SOURCES, r.id));
async function histories(db, rows) {
  const keys = [...new Set([...rows.filter(sharedPayout).map((r) => key(r.id)), ...estimatedRows(rows).map((r) => effortKey(r.id)),
    ...(rows.some((r) => r.id === PEARLHASH) ? [PH_KEY] : []), CHAIN_KEY])];
  if (!keys.length) return new Map();
  const { results } = await db.prepare(`SELECT k,v FROM kv WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
  return new Map(results.flatMap(({ k, v }) => { try { return [[k, JSON.parse(v)]]; } catch { return []; } }));
}

// The merges return a new object even when nothing changed; rewriting a list of up to 3,000 blocks
// every five minutes for nothing costs D1 writes.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/// `fetchJSON(url, budget)` reads a pool's block list; without it the stored lists are used as they are.
/// `prefetched` (url → parsed body) holds pages the snapshot itself just read — the explorer's
/// /api/public, HeroMiners' /api/stats — used as they are instead of asking those pools again.
export async function recordPPLNSSnapshot(db, snapshot, fetchJSON = null, prefetched = null) {
  if (snapshot.stale) return;
  if (fetchJSON && prefetched) {
    const fetchUpstream = fetchJSON;
    fetchJSON = (url, budget) => Object.hasOwn(prefetched, url) && prefetched[url] != null
      ? Promise.resolve(prefetched[url]) : fetchUpstream(url, budget);
  }
  const stored = await histories(db, snapshot.rows), writes = [], summary = [];
  const ids = [...new Set(estimatedRows(snapshot.rows).map((r) => r.id))];
  // The block lists, PearlHash's rate and the explorer's orphans do not depend on each other: asked
  // for together, the snapshot's first reader waits for the slowest, not for all three in turn.
  const [efforts, pearlhash, recent] = await Promise.all([
    fetchJSON ? refreshEfforts(stored, ids, snapshot.ts, fetchJSON)
      : new Map(ids.map((id) => [id, validEffort(stored.get(effortKey(id))) ? stored.get(effortKey(id)) : null])),
    fetchJSON ? recordPearlHash(stored, snapshot, fetchJSON) : null,
    fetchJSON ? Promise.resolve().then(() => fetchJSON("https://lordofpearls.xyz/api/public", "overview-lop"))
      .then((o) => o?.orphans?.recent ?? null, () => null) : null,
  ]);
  for (const [id, effort] of efforts) if (effort && !same(effort, stored.get(effortKey(id))))
    writes.push(db.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(effortKey(id), JSON.stringify(effort), snapshot.ts));
  if (pearlhash) writes.push(db.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(PH_KEY, JSON.stringify(pearlhash), snapshot.ts));
  let chain = validChain(stored.get(CHAIN_KEY)) ? stored.get(CHAIN_KEY) : null;
  if (fetchJSON) {
    const next = extendChainOrphans(chain, recent, snapshot.rows, snapshot.ts, (id, row) => counterSeed(stored.get(key(id)), row, snapshot.ts));
    if (next && !same(next, chain)) { chain = next; writes.push(db.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)").bind(CHAIN_KEY, JSON.stringify(chain), snapshot.ts)); }
  }
  const orphanRate = (row) => worseOrphans(efforts.get(row.id) ? orphanWindow(efforts.get(row.id), snapshot.ts) : null,
    chain && !row.solo ? chainOrphanWindow(chain, row.id, snapshot.ts) : null);
  const summarized = new Set();
  for (const row of snapshot.rows) {
    const point = pplnsPoint(snapshot, row);
    if (!point) continue;
    const previous = stored.get(key(row.id)), next = extendPPLNSHistory(previous, row.id, row.name, point);
    if (next !== previous) writes.push(db.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
      .bind(key(row.id), JSON.stringify(next), snapshot.ts));
    // Every shared contract gets luck windows; a cost estimate only where `costEstimated` says so
    // and the pool publishes its blocks' effort. The measurement keeps scheme "PPLNS": it names
    // the kind of estimate, not the pool's contract.
    const pplns = costEstimated(row, sharedPayout(row)) ? pplnsMeasurement(next, snapshot.ts, efforts.get(row.id)) : null;
    summary.push({ id: row.id, pool: row.name, luck: luckWindows(next, snapshot.ts), pplns, orphans: orphanRate(row) });
    summarized.add(row.id);
  }
  // Pools with no shared contract (PPS) still get the chain's orphan rate.
  for (const row of snapshot.rows) {
    if (summarized.has(row.id) || row.solo || !row.id || !row.name) continue;
    const orphans = orphanRate(row);
    if (orphans) summary.push({ id: row.id, pool: row.name, luck: {}, pplns: null, orphans });
  }
  if (summary.length) writes.push(db.prepare("INSERT OR REPLACE INTO kv(k,v,ts) VALUES(?,?,?)")
    .bind(SUMMARY_KEY, JSON.stringify({ ts: snapshot.ts, rows: summary }), snapshot.ts));
  if (writes.length) await db.batch(writes);
}

/// The latest recorded windows and PPLNS estimates → { pplns: [measurement], luck: Map(id → { pool, windows }) }.
export async function readPoolLuck(db, t = now()) {
  const out = { pplns: [], luck: new Map() };
  let o = null;
  try { o = JSON.parse((await db.prepare("SELECT v FROM kv WHERE k=?").bind(SUMMARY_KEY).first())?.v || "null"); } catch {}
  if (!o || !finite(o.ts) || o.ts > t + 60 || o.ts < t - 1800 || !Array.isArray(o.rows)) return out;
  for (const r of o.rows) {
    if (typeof r?.id !== "string" || typeof r.pool !== "string") continue;
    // A summary written before a rename is read under the new name.
    if (validPPLNSMeasurement(r.pplns, t) && r.pplns.id === r.id) out.pplns.push({ ...r.pplns, pool: currentName(r.pplns.pool) });
    const windows = Object.fromEntries(Object.entries(LUCK_WINDOWS)
      .flatMap(([name, span]) => validLuck(r.luck?.[name], span, t) ? [[name, r.luck[name]]] : []));
    const orphans = validOrphans(r.orphans, t) ? { start: r.orphans.start, end: r.orphans.end, blocks: r.orphans.blocks,
      orphans: r.orphans.orphans, source: r.orphans.source ?? "pool" } : null;
    if (Object.keys(windows).length || orphans) out.luck.set(r.id, { pool: currentName(r.pool), windows, orphans });
  }
  return out;
}

/// Rows gain `luck` — the windows recorded under the same id and pool name, or null — and
/// `orphans`, the pool's own orphan count over the last week, or null.
export function attachLuck(snapshot, luck) {
  return { ...snapshot, rows: snapshot.rows.map((row) => {
    const found = luck.get(row.id), own = !!found && found.pool === row.name && !row.solo;
    return { ...row, luck: own && Object.keys(found.windows).length ? found.windows : null, orphans: own ? found.orphans ?? null : null };
  }) };
}
