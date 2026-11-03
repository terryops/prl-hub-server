// 到账提醒 — a push when the PRL address the user gave receives a payment.
//
// One address per device (Pro), sent with the device's registration (`income`). The worker
// reads each new block once, whoever watches what: Blockbook's /api/v2/block/<height> lists
// every transaction with the addresses on both sides, and the addresses its outputs pay are
// looked up among the watched ones in one query. That is one block read about every 3.4 minutes
// and one tiny tip request a minute, not a request per device. A payment counts from its first
// confirmation.
//
// What counts: outputs to the address in a transaction that spends nothing from it. One that
// does is the owner's own (a send, and the change it returns), never income. A coinbase paying
// the address (solo mining) counts.
//
// What is news: a block is matched against the addresses watched when it is read, so a payment
// confirmed before an address was set is only ever seen while the reader catches up (at most
// MAX_BEHIND blocks); of those, one in a block stamped more than GRACE before the address was set
// is passed over.
//
// Delivery is at most once, as for the other alerts: what is about to go out is committed as
// told first, and put back only if the push didn't go through for a transient reason. `told`
// keeps the latest txids pushed, so a transaction that turns up again (in the block that replaced
// the one it was in) is not pushed twice. Quiet hours, an APNs back-off or this tick's push budget
// hold the news in `pending` until the device can be told; news held longer than PENDING_KEEP is
// dropped, and only the newest PENDING_MAX are held.
//
// The cursor (kv 'income:cursor') is the height read last and the hashes of the latest blocks
// read. A block whose parent is not the one read last means the chain changed under us: the reader
// steps back and reads the replacement too. A cursor far behind the tip (the indexers were down, or
// nobody watched for a while) jumps ahead: payments that old are not news.

import { ADDRESS_RE, TXID_RE, atomic, indexers, blockbookJSON, blockbookHeight } from "./chain.js";
import { cleanLabel } from "./watch.js";
import { deliver, channelConfigured } from "./push.js";
import { windowOpen } from "./rules.js";
import { incomePayloadFor } from "./i18n.js";
import { now } from "./http.js";

export const CURSOR = "income:cursor";
/// Block reads per tick, steps back after a reorg included…
export const BLOCKS_PER_TICK = 6;
/// …and no new one is started this long into the scan: the cron's other work waits behind it.
const READ_WALL_MS = 20_000;
/// A cursor more blocks than this behind the tip starts again at the tip (about 70 minutes).
export const MAX_BEHIND = 20;
/// Hashes of the latest blocks read, for noticing a reorg.
const KEEP_HASHES = 6;
/// Ticks a block may fail to read before it is skipped, so one block no indexer will hand over
/// whole can't hold up every block after it.
export const BLOCK_FAILS = 5;
/// A block page holds up to 1,000 transactions; an exchange's sweep of 1,500 inputs is 0.7 MB of
/// JSON on its own. The largest of 138 blocks sampled on 2026-10-30 was 1.9 MB.
export const MAX_BLOCK_BODY = 8_000_000;
const MAX_PAGES = 20;
/// Payments held per device (the newest), and txids remembered as pushed: at least as many, so
/// every txid of one push is remembered.
export const PENDING_MAX = 100;
export const TOLD_KEEP = 100;
/// News held (quiet hours, back-off) this long is dropped.
export const PENDING_KEEP = 48 * 3600;
/// A block's timestamp may run some 20 minutes behind the clock (it only has to pass the median of
/// the last 11): a catch-up block stamped more than this before the address was set is passed over.
/// Well inside the catch-up window (MAX_BEHIND blocks, about 70 minutes), or nothing read on
/// catching up would ever be passed over.
export const GRACE = 20 * 60;
/// Pushes per tick in all; the rest go at the next one.
export const PUSHES_PER_TICK = 200;
/// Pushes per tick to tokens APNs never accepted.
const INCOME_UNVERIFIED_PER_TICK = 20;
/// A payment push is still worth delivering this much later.
const INCOME_TTL = 12 * 3600;
/// Addresses per lookup of the watched ones (a JSON array bound as one parameter).
const LOOKUP_CHUNK = 2000;
const INCOME_BATCH = 50;

/// Validate the client's { addr, label? } → { addr, label }, or null.
export function sanitizeIncome(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const addr = typeof o.addr === "string" ? o.addr.trim().toLowerCase() : "";
  if (!ADDRESS_RE.test(addr)) return null;
  return { addr, label: cleanLabel(o.label) };
}

/// Insert or replace a device's address. Pointed at another address it starts over: what it
/// heard about the old one says nothing about the new, and earlier payments are not news.
/// Binds: token, addr, label, now, then the guard's arguments.
export const upsertIncome = (guard) => `
  INSERT INTO income_watches (token, addr, label, since) SELECT ?1, ?2, ?3, ?4 WHERE ${guard}
  ON CONFLICT(token) DO UPDATE SET
    told = CASE WHEN income_watches.addr = excluded.addr THEN income_watches.told ELSE '[]' END,
    pending = CASE WHEN income_watches.addr = excluded.addr THEN income_watches.pending ELSE '[]' END,
    since = CASE WHEN income_watches.addr = excluded.addr THEN income_watches.since ELSE excluded.since END,
    addr = excluded.addr, label = excluded.label`;

/// What one block's transactions pay: [{ addr, txid, sats }], one entry per transaction and
/// address (its outputs to the address added up), for the addresses in `watched` (all, if null).
export function receipts(txs, watched = null) {
  const out = [];
  if (!Array.isArray(txs)) return out;
  for (const tx of txs) {
    if (typeof tx?.txid !== "string" || !TXID_RE.test(tx.txid) || !Array.isArray(tx.vout)) continue;
    const spends = new Set((Array.isArray(tx.vin) ? tx.vin : []).flatMap((io) => Array.isArray(io?.addresses) ? io.addresses : []));
    const paid = new Map();
    for (const io of tx.vout) {
      const a = Array.isArray(io?.addresses) && io.addresses.length === 1 ? io.addresses[0] : null;
      if (typeof a !== "string" || (watched && !watched.has(a)) || spends.has(a)) continue;
      let v;
      try { v = atomic(io.value ?? "0"); } catch { continue; }
      paid.set(a, (paid.get(a) ?? 0n) + v);
    }
    for (const [addr, sats] of paid) if (sats > 0n) out.push({ addr, txid: tx.txid, sats });
  }
  return out;
}

/// The stored cursor, or null for anything unreadable.
export function parseCursor(s) {
  try {
    const o = JSON.parse(s);
    if (!Number.isSafeInteger(o?.h) || o.h < 0) return null;
    const hashes = Array.isArray(o.hashes) ? o.hashes.filter((x) => typeof x === "string").slice(0, KEEP_HASHES) : [];
    return { h: o.h, hashes, fails: Number.isSafeInteger(o.fails) && o.fails > 0 ? o.fails : 0 };
  } catch { return null; }
}

const incomeList = (s) => {
  try { const o = JSON.parse(s); return Array.isArray(o) ? o : []; } catch { return []; }
};
/// A held payment as stored: [txid, sats as a decimal string, found at (unix s)].
const heldOK = (p) => Array.isArray(p) && typeof p[0] === "string" && TXID_RE.test(p[0])
  && typeof p[1] === "string" && /^[1-9]\d{0,29}$/.test(p[1]) && Number.isSafeInteger(p[2]);

/// The chain tip as the first indexer in sync sees it (ours first), with that indexer.
async function incomeTip(env) {
  for (const [name, base, headers] of indexers(env)) {
    try { return { name, base, headers, height: await blockbookHeight(base, headers) }; } catch { /* the next one */ }
  }
  return null;
}

/// Block `height` with every page of its transactions, from `src`.
async function readBlockFrom(src, height) {
  const get = (path) => blockbookJSON(src.base, path, { headers: src.headers, max: MAX_BLOCK_BODY });
  const first = await get(`/api/v2/block/${height}`);
  // Without its parent's hash a block can't be placed in the chain: a failed read, not a reorg.
  if (first.height !== height || typeof first.hash !== "string" || !Array.isArray(first.txs) ||
      typeof first.previousBlockHash !== "string") throw new Error("invalid block");
  const txs = [...first.txs];
  const pages = Number.isSafeInteger(first.totalPages) ? first.totalPages : 1;
  if (pages > MAX_PAGES) throw new Error("block too large");
  for (let p = 2; p <= pages; p++) {
    const o = await get(`/api/v2/block/${height}?page=${p}`);
    // The block changed between pages (a reorg): read it again next tick.
    if (o.hash !== first.hash || !Array.isArray(o.txs)) throw new Error("block changed");
    txs.push(...o.txs);
  }
  return { hash: first.hash, prev: first.previousBlockHash, time: Number.isSafeInteger(first.time) ? first.time : 0, txs };
}

/// …from the indexer that gave the tip, else the others; one that failed a read this tick
/// (`bad`) is not asked again in it, so a slow indexer costs one timeout per tick, not one a block.
async function readBlock(env, src, height, bad) {
  const order = [src, ...indexers(env).filter(([name]) => name !== src.name).map(([name, base, headers]) => ({ name, base, headers }))];
  let error = new Error("no indexer");
  for (const x of order) {
    if (bad.has(x.name)) continue;
    try { return await readBlockFrom(x, height); } catch (e) { bad.add(x.name); error = e; }
  }
  throw error;
}

/// Of `found`, the payments to addresses someone watches.
async function watchedOnly(db, found) {
  const addrs = [...new Set(found.map((f) => f.addr))];
  const watched = new Set();
  for (let i = 0; i < addrs.length; i += LOOKUP_CHUNK) {
    const { results } = await db
      .prepare("SELECT DISTINCT addr FROM income_watches WHERE addr IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(addrs.slice(i, i + LOOKUP_CHUNK)))
      .all();
    for (const r of results) watched.add(r.addr);
  }
  return found.filter((f) => watched.has(f.addr));
}

/// Read the blocks since the cursor and move it on. → [{ addr, txid, sats, time }] paid to the
/// watched addresses; empty when another tick read these blocks (its cursor write got there first).
async function newPayments(env, db, t) {
  const src = await incomeTip(env);
  if (!src) return [];
  const row = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(CURSOR).first();
  let cur = parseCursor(row?.v);
  if (!cur || src.height - cur.h > MAX_BEHIND) cur = { h: src.height - 1, hashes: [], fails: 0 };
  if (row && cur.h >= src.height) return [];
  const started = Date.now();
  const bad = new Set();
  let found = [];
  for (let reads = 0; cur.h < src.height && reads < BLOCKS_PER_TICK && Date.now() - started < READ_WALL_MS; reads++) {
    let b;
    try {
      b = await readBlock(env, src, cur.h + 1, bad);
    } catch {
      if (++cur.fails < BLOCK_FAILS) break;
      console.error(`income: block ${cur.h + 1} skipped after ${BLOCK_FAILS} failed reads`);
      cur = { h: cur.h + 1, hashes: [], fails: 0 };
      // It was the block, not the indexers: ask them again for the next one.
      bad.clear();
      continue;
    }
    if (cur.hashes.length && b.prev !== cur.hashes[0]) {
      // The block read last at cur.h is no longer in the chain: step back and read what replaced it.
      cur = { h: cur.h - 1, hashes: cur.hashes.slice(1), fails: 0 };
      continue;
    }
    for (const r of receipts(b.txs)) found.push({ ...r, time: b.time });
    cur = { h: cur.h + 1, hashes: [b.hash, ...cur.hashes].slice(0, KEEP_HASHES), fails: 0 };
  }
  // Looked up before the cursor moves: a failed lookup leaves these blocks to be read again.
  if (found.length) found = await watchedOnly(db, found);
  const next = JSON.stringify(cur);
  if (row?.v === next) return found;
  const claim = row
    ? await db.prepare("UPDATE kv SET v = ?, ts = ? WHERE k = ? AND v = ?").bind(next, t, CURSOR, row.v).run()
    : await db.prepare("INSERT OR IGNORE INTO kv (k, v, ts) VALUES (?, ?, ?)").bind(CURSOR, next, t).run();
  return claim?.meta?.changes ? found : [];
}

const SUB_COLUMNS = `i.token, i.addr, i.label, i.since, i.told, i.pending,
  d.chan, d.env, d.topic, d.lang, d.win_start, d.win_end, d.tz, d.retry_after, d.verified_at
  FROM income_watches i JOIN devices d ON d.token = i.token`;

/// The watches holding news (partial index income_watches_pending), and those of the addresses
/// just paid (income_watches_addr) — never the whole table.
async function subscribers(db, found) {
  const { results: held } = await db.prepare(`SELECT ${SUB_COLUMNS} WHERE i.pending <> '[]'`).all();
  if (!found.length) return held;
  const { results: paid } = await db
    .prepare(`SELECT ${SUB_COLUMNS} WHERE i.addr IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...new Set(found.map((f) => f.addr))]))
    .all();
  return [...new Map([...held, ...paid].map((s) => [s.token, s])).values()];
}

/// Each tick (after the price work): read the new blocks, then push every device whose address
/// they paid, and whatever was held for a device that can now be told.
/// `forget(db, token)` → the statements that drop a device APNs / FCM says is gone.
export async function scanIncome(env, { forget } = {}) {
  const db = env.DB;
  const t = now();
  if (!await db.prepare("SELECT 1 FROM income_watches LIMIT 1").first()) return;
  const found = await newPayments(env, db, t);
  const subs = await subscribers(db, found);
  if (!subs.length) return;
  const byAddr = new Map();
  for (const f of found) (byAddr.get(f.addr) || byAddr.set(f.addr, []).get(f.addr)).push(f);

  let pushes = 0, unproven = 0;
  const admit = (s) => {
    if (pushes >= PUSHES_PER_TICK || !channelConfigured(env, s) || s.retry_after > t) return false;
    if (!windowOpen({ start: s.win_start, end: s.win_end, tz: s.tz }, t)) return false;
    if (!s.verified_at && ++unproven > INCOME_UNVERIFIED_PER_TICK) return false;
    pushes++;
    return true;
  };
  const jobs = [];
  for (const s of subs) {
    const told = incomeList(s.told).filter((x) => typeof x === "string");
    let pending = incomeList(s.pending).filter((p) => heldOK(p) && t - p[2] < PENDING_KEEP);
    const known = new Set([...told, ...pending.map((p) => p[0])]);
    for (const f of byAddr.get(s.addr) || []) {
      if (known.has(f.txid) || f.time < s.since - GRACE) continue;
      known.add(f.txid);
      pending.push([f.txid, f.sats.toString(), t]);
    }
    pending = pending.slice(-PENDING_MAX);
    const send = pending.length && admit(s) ? pending : [];
    const claimTold = JSON.stringify(send.length ? [...send.map((p) => p[0]).reverse(), ...told].slice(0, TOLD_KEEP) : told);
    const claimPending = JSON.stringify(send.length ? [] : pending);
    if (claimTold !== s.told || claimPending !== s.pending) jobs.push({ s, send, told, pending, claimTold, claimPending });
  }
  // The claim matches the row exactly as read: it loses to a PUT that changed the address and to
  // another tick that already told it.
  const claims = jobs.map((j) => db
    .prepare("UPDATE income_watches SET told = ?, pending = ? WHERE token = ? AND addr = ? AND told = ? AND pending = ?")
    .bind(j.claimTold, j.claimPending, j.s.token, j.s.addr, j.s.told, j.s.pending));
  const res = [];
  for (let i = 0; i < claims.length; i += INCOME_BATCH) res.push(...await db.batch(claims.slice(i, i + INCOME_BATCH)));
  const mine = jobs.filter((j, i) => j.send.length && res[i]?.meta?.changes > 0);
  // Async, so a payload that can't be built is one failed push, not a throw past every other one.
  const sent = await Promise.allSettled(mine.map(async ({ s, send }) =>
    deliver(env, db, s, incomePayloadFor(s.lang, s, send.map((p) => ({ txid: p[0], sats: BigInt(p[1]) }))), { ttl: INCOME_TTL })));
  const after = [];
  const dead = new Set();
  let ok = 0;
  sent.forEach((r, i) => {
    const { s, told, pending, claimTold } = mine[i];
    const out = r.status === "fulfilled" ? r.value : { ok: false, retry: true, reason: String(r.reason) };
    if (out.ok) {
      ok++;
      if (out.env !== s.env || !s.verified_at) {
        after.push(db.prepare("UPDATE devices SET env = ?, verified_at = COALESCE(verified_at, ?) WHERE token = ?").bind(out.env, t, s.token));
      }
    } else if (out.drop) {
      dead.add(s.token);
    } else if (out.retry) {
      // Not delivered: held again for the next tick, if the claim is still ours.
      after.push(db.prepare("UPDATE income_watches SET told = ?, pending = ? WHERE token = ? AND told = ? AND pending = '[]'")
        .bind(JSON.stringify(told), JSON.stringify(pending), s.token, claimTold));
      if (out.backoff) after.push(db.prepare("UPDATE devices SET retry_after = ? WHERE token = ?").bind(t + out.backoff, s.token));
      console.log("income push retry", s.token.slice(0, 8), out.status, out.reason);
    } else {
      console.error("income push refused", s.token.slice(0, 8), out.status, out.reason);
    }
  });
  for (const token of dead) after.push(...(forget ? forget(db, token) : [db.prepare("DELETE FROM income_watches WHERE token = ?").bind(token)]));
  for (let i = 0; i < after.length; i += INCOME_BATCH) await db.batch(after.slice(i, i + INCOME_BATCH));
  if (found.length || mine.length) console.log(`income found=${found.length} subs=${subs.length} pushed=${ok}/${mine.length} dead=${dead.size}`);
}
