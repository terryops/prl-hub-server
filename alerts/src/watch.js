// 掉线提醒 — pure, no I/O, so it is unit-testable in plain Node.
//
// A device subscribes a pool monitor ("watch") to offline pushes: tell me when a
// worker has been offline for `after` seconds (10, 15, 30 or 60 min) — and, once it
// has been told that, when the worker is back. The worker polls each distinct
// (pool, miner) every POLL_EVERY and keeps two things:
//
//   miners.workers   what the pool last showed, per worker name:
//                      0    online
//                      > 0  offline since then (unix s) — its last share where the pool
//                           publishes one, else the poll that first found it offline / gone
//                      < 0  offline since -value, but never seen online by us (it was
//                           already dead when first listed): never worth a push
//   watches.told     per subscription, the outages it already heard about:
//                      { name: [since, pushedAt, backAt?, backPushedAt?] }
//                    pushedAt 0 = noted at the first look, never pushed; backAt = the
//                    poll that found the worker online again; backPushedAt = when the
//                    device was told so.
//
// A push goes out once per outage, when it has lasted `after`. A worker that
// comes back and drops again is a new outage, but the same worker is not pushed
// twice within COOLDOWN — a flapping one would otherwise ring all night.
// Whatever is already down when the alert is switched on is not news.
//
// Every "offline" that was pushed is answered by one "back online", and by nothing
// else: until the device has been told the worker is back, that worker dropping
// again is not news to it. The worker counts as back once it is still online at a
// poll STEADY after the one that first found it so — one that only flickers is not
// announced — and the caller polls its miner again RECHECK later to find out.

import { POOLS, sanitizeTarget } from "./pools.js";

export const POLL_EVERY = 180;
export const AFTER = [600, 900, 1800, 3600];
export const COOLDOWN = 1800;
/// How soon a miner with a worker just back is polled again, and how long that worker
/// must then have stayed online: cron ticks land a few seconds either side of the
/// minute, so a full 60 here would make every other one wait for a second look.
export const RECHECK = 60;
export const STEADY = 45;
/// An offline worker the pool no longer lists is forgotten after this long.
const FORGET_AFTER = 7 * 86400;

// Worker names are whatever a miner typed, used as keys: these maps have no
// prototype, so "__proto__" or "constructor" is a name like any other.
const bag = () => Object.create(null);

/// Stored JSON → map ({} for anything unreadable).
export function unpack(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? Object.assign(bag(), o) : bag();
  } catch { return bag(); }
}

/// A map as stored: JSON with sorted keys, so one that hasn't changed is byte-identical
/// to the stored copy whatever order the pool listed its workers in this time (the
/// stage compares the two to decide whether a row needs writing at all).
export const pack = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));

/// Fold one successful poll into a miner's stored state.
/// prev: { name: since }; seen: [{ name, online, last }]; partial: the pool showed
/// only part of the list, so a worker missing from it is left as it was.
export function fold(prev, seen, t, partial = false) {
  const next = bag();
  const listed = new Set();
  for (const w of seen) {
    listed.add(w.name);
    if (w.online) { next[w.name] = 0; continue; }
    const was = prev[w.name];
    const since = w.last ? Math.min(w.last, t) : Math.abs(was) || t;
    // Offline the first time we see it at all: not something that went down on our watch.
    next[w.name] = was === undefined || was < 0 ? -since : since;
  }
  for (const [name, since] of Object.entries(prev)) {
    if (listed.has(name)) continue;
    if (since === 0) next[name] = partial ? 0 : t;           // was online: left as it was, or gone from a full list
    else if (t - Math.abs(since) < FORGET_AFTER) next[name] = since;
  }
  return next;
}

/// What one subscription should hear now.
/// state: the miner's { name: since }; told: { name: [since, pushedAt, backAt?, backPushedAt?] };
/// after: its threshold (s); fresh: this is its first look (nothing is news yet).
/// → { push: [{ name, since }]       outages to announce
///     back: [{ name, since, at }]   workers to announce as back (offline since → at)
///     wait: a worker is back but not for STEADY yet — poll the miner again soon
///     told } — `told` as it stands if nothing is sent: the caller folds in what it
///   does send (`tell`).
export function due(state, told, after, t, fresh = false) {
  const next = bag();
  const push = [];
  const back = [];
  let wait = false;
  for (const [name, since] of Object.entries(state)) {
    const old = Array.isArray(told[name]) ? told[name] : null;
    const cooling = old && t - old[1] < COOLDOWN;
    // Pushed as offline, not yet as back: all this device can still hear is "back online".
    const owed = old && old[1] > 0 && !old[3];
    if (since === 0 && owed) {
      const at = old[2] || t;
      next[name] = [old[0], old[1], at];
      if (t - at >= STEADY) back.push({ name, since: old[0], at });
      else wait = true;
    } else if (since <= 0) {
      if (cooling) next[name] = old;
    } else if (owed) {
      next[name] = [old[0], old[1]];                         // down again (or still): its return starts over
    } else if (old && (cooling || (old[0] === since && !old[3]))) {
      // It rang just now, or this outage is known — unless the device has since been
      // told the worker was back: then the same last share is a new outage all the same.
      next[name] = old;
    } else if (t - since >= after) {
      if (fresh) next[name] = [since, 0];
      else push.push({ name, since });
    }
  }
  return { push, back, wait, told: next };
}

/// `told` once these have gone out at t. A worker announced as back stays on record
/// only while its cool-down runs: dropping again must not ring before that is over.
export function tell(told, push, back, t) {
  const next = Object.assign(bag(), told);
  for (const p of push) next[p.name] = [p.since, t];
  for (const b of back) {
    const [since, pushedAt] = next[b.name];
    if (t - pushedAt < COOLDOWN) next[b.name] = [since, pushedAt, b.at, t];
    else delete next[b.name];
  }
  return next;
}

/// Validate one client-supplied watch; returns a normalized one or null.
/// { id, pool, addr, acct?, label?, after? } — acct: F2Pool's account name.
export function sanitizeWatch(w) {
  if (!w || typeof w !== "object") return null;
  const id = typeof w.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(w.id) ? w.id : null;
  if (!id || typeof w.pool !== "string" || !POOLS.includes(w.pool)) return null;
  const addr = sanitizeTarget(w.pool, w.addr, w.acct);
  if (!addr) return null;
  const label = typeof w.label === "string" ? w.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "";
  return { id, pool: w.pool, addr, label, after: AFTER.includes(w.after) ? w.after : AFTER[0] };
}

/// Insert or update one watch. A watch pointed at another miner starts over: what it
/// heard about the old one says nothing about the new. Binds: token, id, pool, addr,
/// label, after.
export const upsertWatch = (guard = null) => `
  INSERT INTO watches (token, id, pool, addr, label, after)
  ${guard == null ? "VALUES (?1, ?2, ?3, ?4, ?5, ?6)" : `SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${guard}`}
  ON CONFLICT(token, id) DO UPDATE SET
    told = CASE WHEN watches.pool = excluded.pool AND watches.addr = excluded.addr THEN watches.told ELSE '{}' END,
    base = CASE WHEN watches.pool = excluded.pool AND watches.addr = excluded.addr THEN watches.base ELSE 0 END,
    pool = excluded.pool, addr = excluded.addr, label = excluded.label, after = excluded.after`;
export const UPSERT_WATCH = upsertWatch();
