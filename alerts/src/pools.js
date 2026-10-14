// 掉线提醒: one miner's workers on one pool — which are online, and when each was
// last heard from. The same endpoints and the same "online" rule as the app's
// per-pool sources (Sources/WidgetShared/Pools/*.swift), so a push never
// disagrees with the app's monitor card.
//
// Every URL requested is built here from a pool in POOLS and an identifier that
// passed sanitizeTarget — never from a URL a client sent.

/// A worker counts as online for this long after its last share, on the pools
/// that publish only a timestamp (the app's rule).
const STALE = 600;
export const TIMEOUT_MS = 8_000;
export const MAX_BODY = 2_000_000;
/// Workers tracked per miner; a longer list is cut (by name) and read as partial.
export const MAX_WORKERS = 500;
export const UA = "PearlHubAlerts/1.0 (+https://pearlhub.net)";
/// The name tracked for a worker the pool lists without one (i18n.js shows it localized).
export const ANON = "(unnamed)";

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") { const n = Number(v.replace(/,/g, "")); return Number.isFinite(n) ? n : 0; }
  return 0;
};
const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
/// A unix-seconds stamp, or null when the pool gave none.
const stamp = (s) => (s > 0 ? Math.floor(s) : null);
const MISSING = { missing: true };

// Each pool: `url(addr)` (+ `headers`), `gone` — the HTTP statuses that mean "no
// such miner here" — and `parse(json, now)` → { workers, partial? } | MISSING.
// A worker is { name, online, last } — last = unix s of its last share, or null.
export const SOURCES = {
  AlphaPool: {
    url: (a) => `https://pearl.alphapool.tech/api/miner/${a}`,
    // Answers 200 for any address; a stranger has no history at all.
    parse(o, now) {
      const rigs = list(o.workers);
      const known = num(o.last_seen) > 0 || rigs.length > 0 || num(o.balance_prl) > 0
        || num(o.total_paid_prl) > 0 || num(o.estHash24hRaw) > 0;
      if (!known) return MISSING;
      return {
        workers: rigs.map((w) => {
          const last = stamp(num(w.time));
          return { name: text(w.name), online: typeof w.online === "boolean" ? w.online : last != null && now - last < STALE, last };
        }),
      };
    },
  },
  "Lucky Pool": {
    url: (a) => `https://pearl.luckypool.io/api/stats_address?address=${a}`,
    gone: [404],
    parse(o, now) {
      if (!o.stats) return MISSING;
      return {
        workers: list(o.workers).map((w) => {
          const last = stamp(num(w.lastShare) / 1000);   // epoch ms, as a string
          // No usable stamp: the pool listing the worker at all is the signal.
          return { name: text(w.name), online: last == null || now - last < STALE, last };
        }),
      };
    },
  },
  HeroMiners: {
    url: (a) => `https://pearl.herominers.com/api/stats_address?address=${a}&longpoll=false`,
    // A stranger gets 200 {"error":"Not found"}.
    parse(o, now) {
      const rigs = list(o.workers);
      if (!o.stats && !rigs.length) return MISSING;
      return {
        workers: rigs.map((w) => {
          const last = stamp(num(w.lastShare));
          return { name: text(w.name), online: last != null && now - last < STALE, last };
        }),
      };
    },
  },
  "Pearl Fortune": {
    // `configured` is true for any address, so this pool never says "no such miner".
    url: (a) => `https://pearlfortune.org/api/v1/miners/${a}/connections`,
    parse(o) {
      if (!o.data || typeof o.data !== "object") throw new Error("no data");
      return {
        workers: list(o.data.workers).map((w) => ({
          name: text(w.worker), online: w.stale === false, last: stamp(Date.parse(text(w.last_stats_at)) / 1000),
        })),
      };
    },
  },
  PearlHash: {
    url: (a) => `https://pearlhash.xyz/api/account/${a}`,
    gone: [404],
    // Lists the connected workers only: one that drops just disappears. Repeats of a
    // name are numbered, so two workers under one name stay two. They are often
    // unnamed; those are counted as ANON, ANON (2)… and NOT told apart by IP (the
    // app's label for them): a rig whose address changed would read as one worker
    // gone and another arrived, and be pushed as offline.
    parse(o) {
      const seen = new Map();     // names are whatever a miner typed: "constructor" is a name
      return {
        workers: list(o.connected_workers).map((w) => {
          const base = text(w.worker_name) || ANON;
          const n = (seen.get(base) || 0) + 1;
          seen.set(base, n);
          return { name: n > 1 ? `${base} (${n})` : base, online: true, last: null };
        }),
      };
    },
  },
  Kryptex: {
    // 200 with an empty list for an address that never mined here.
    url: (a) => `https://prl-api.kryptex.network/api/v3/miner/workers/${a}`,
    parse(o, now) {
      return {
        workers: list(o.results).map((w) => {
          // A wallet on both schemes lists one name twice.
          const solo = text(w.scheme).toLowerCase() === "solo";
          return { name: (text(w.worker) || "—") + (solo ? " (SOLO)" : ""), online: text(w.status).toLowerCase() === "online",
                   last: stamp(num(w.last_share) / 1000) };
        }),
      };
    },
  },
  F2Pool: {
    // The account's read-only page; `addr` is "<key>" or "<key>/<account>".
    // X-Requested-With is what makes it answer JSON instead of the HTML page.
    url(a) {
      const cut = a.indexOf("/");
      const key = cut < 0 ? a : a.slice(0, cut);
      const acct = encodeURIComponent(cut < 0 ? "" : a.slice(cut + 1));
      return `https://www.f2pool.com/mining-user-prl/${key}?user_name=${acct}&action=get_pagination_workers&account=${acct}&currency=PRL`;
    },
    headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json, text/javascript, */*; q=0.01" },
    gone: [404],   // key revoked or mistyped
    parse(o) {
      const d = o.originData;
      if (!d || typeof d !== "object") return MISSING;
      const rigs = list(d.workers);
      // status: 0 online · 1 offline · 2 dead — seen both as a number and a string.
      const up = (s) => s === 0 || (typeof s === "string" && /^\s*0\s*$/.test(s));
      return {
        workers: rigs.map((w) => ({ name: text(w.name), online: up(w.status), last: stamp(num(w.last_share)) })),
        // A page of a longer list: a worker that isn't on it hasn't gone anywhere.
        partial: num(d.worker_length_all) > rigs.length,
      };
    },
  },
};

/// Full cards add balance/ledger requests to the same worker endpoint used by pushes.
export function statsRequests(pool, a) {
  const primary = SOURCES[pool].url(a), p = encodeURIComponent(a);
  switch (pool) {
    case "Pearl Fortune": {
      const base = primary.replace(/\/connections$/, "");
      return [base, primary, `${base}/ledger`];
    }
    case "PearlHash": return [primary, "https://pearlhash.xyz/api/stats"];
    case "Kryptex": return [primary, `https://prl-api.kryptex.network/api/v1/miner/balance/${p}`, `https://prl-api.kryptex.network/api/v1/miner/payouts/${p}/stats`];
    case "F2Pool": {
      const base = primary.split("&action=")[0];
      const acct = encodeURIComponent(a.includes("/") ? a.slice(a.indexOf("/") + 1) : "");
      return [primary, `${base}&action=load_payout_history_outcome&account=${acct}&currency_code=prl`, base];
    }
    default: return [primary];
  }
}

export const POOLS = Object.keys(SOURCES);

/// The stored form of a client's (pool, identifier), or null when it isn't one.
/// Address pools: a lowercase PRL address. F2Pool: the read-only key, plus the
/// account name the page was shared under.
export function sanitizeTarget(pool, addr, acct) {
  if (!Object.hasOwn(SOURCES, pool) || typeof addr !== "string") return null;
  if (pool !== "F2Pool") return /^prl1[0-9a-z]{20,100}$/.test(addr) ? addr : null;
  if (!/^[0-9a-f]{16,64}$/.test(addr)) return null;
  if (acct == null || acct === "") return addr;
  if (typeof acct !== "string" || acct.length > 64 || /[\u0000-\u001f\u007f]/.test(acct)) return null;
  return `${addr}/${acct}`;
}

/// The pool's answer, read: `status` + body → { workers, partial } | { missing }.
/// Throws on anything else (a failed poll says nothing about the workers).
export function parseMiner(pool, status, body, now) {
  const src = SOURCES[pool];
  if ((src.gone || []).includes(status)) return MISSING;
  if (status !== 200) throw new Error(`http ${status}`);
  const o = JSON.parse(body);
  if (!o || typeof o !== "object") throw new Error("not an object");
  const out = src.parse(o, now);
  if (out.missing) return MISSING;
  return normalizeWorkers(out);
}

export function normalizeWorkers(out) {
  // One name, one worker: a second session of the same worker is online if either is.
  const byName = new Map();
  for (const w of out.workers) {
    const name = (w.name || "—").slice(0, 64);
    const old = byName.get(name);
    const rates = w.rates || old?.rates ? Object.fromEntries([...new Set([...Object.keys(old?.rates || {}), ...Object.keys(w.rates || {})])].map((key) => [key, (old?.rates?.[key] || 0) + (w.rates?.[key] || 0)])) : null;
    byName.set(name, { name, online: old ? old.online || w.online : w.online,
      last: old ? Math.max(old.last || 0, w.last || 0) || null : w.last,
      ...(rates ? { rates } : {}) });
  }
  let workers = [...byName.values()];
  let partial = !!out.partial;
  if (workers.length > MAX_WORKERS) {
    workers = workers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, MAX_WORKERS);
    partial = true;
  }
  return { workers, partial };
}

/// The response body as text, given up on once it passes `max` bytes — before the
/// rest is buffered (six polls run side by side, and some pools answer with ledgers).
export async function readCapped(r, max) {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/// Ask the pool. → { ok: true, workers, partial } | { ok: true, missing: true }
///               | { ok: false, status, reason } — couldn't tell; never "offline".
export async function fetchMiner(pool, addr, now) {
  const src = SOURCES[pool];
  let status = 0;
  try {
    const r = await fetch(src.url(addr), {
      headers: { "user-agent": UA, accept: "application/json", ...(src.headers || {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = r.status;
    return { ok: true, ...parseMiner(pool, status, await readCapped(r, MAX_BODY), now) };
  } catch (e) {
    return { ok: false, status, reason: String(e && e.message ? e.message : e).slice(0, 80) };
  }
}
