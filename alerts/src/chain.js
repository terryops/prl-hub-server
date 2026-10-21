// Blockbook access shared by read-only balances and the payment reconciler.
import { readCapped, UA, TIMEOUT_MS, MAX_BODY } from "./pools.js";
import { cached, sha256, webJson as json, now } from "./http.js";
import { reserveBudget } from "./poolstats.js";
export const ADDRESS_RE = /^prl1[0-9a-z]{20,100}$/;
export const atomic = (v) => {
  if (typeof v !== "string" || !/^\d+$/.test(v))
    throw new Error("invalid amount");
  return BigInt(v);
};
const signedAtomic = (v) => {
  if (typeof v !== "string" || !/^-?\d+$/.test(v))
    throw new Error("invalid amount");
  return BigInt(v);
};
export function totalTo(rows, addr) {
  if (!Array.isArray(rows)) throw new Error("missing transaction entries");
  return rows.reduce(
    (s, x) =>
      s +
      (Array.isArray(x.addresses) && x.addresses.includes(addr)
        ? atomic(x.value)
        : 0n),
    0n,
  );
}
export async function chainAddress(env, addr, pageSize = 20, page = 1) {
  const base = (env.BLOCKBOOK_BASE || "https://blockbook.pearlresearch.ai")
    .replace(/\/$/, "")
    .replace(/\/api\/v2$/, "");
  const r = await fetch(
    `${base}/api/v2/address/${addr}?details=txs&pageSize=${pageSize}&page=${page}`,
    {
      headers: { "user-agent": UA, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (r.status !== 200) throw new Error("upstream");
  const o = JSON.parse(await readCapped(r, MAX_BODY));
  if (!o || o.error || (!Array.isArray(o.transactions) && o.txs !== 0))
    throw new Error("invalid address response");
  o.transactions ||= [];
  return o;
}
export async function chainHeight(env) {
  const base = (env.BLOCKBOOK_BASE || "https://blockbook.pearlresearch.ai").replace(/\/$/, "").replace(/\/api\/v2$/, "");
  const r = await fetch(`${base}/api/`, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status !== 200) throw new Error("upstream");
  const o = JSON.parse(await readCapped(r, MAX_BODY)), height = o?.blockbook?.bestHeight;
  if (!Number.isSafeInteger(height) || height < 0 || o.blockbook.inSync === false) throw new Error("invalid chain height");
  return height;
}
export async function address(env, body, ctx) {
  const addr = body?.addr;
  const page = body?.page ?? 1;
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr))
    return json({ ok: false, error: "bad address" }, 400);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) return json({ ok: false, error: "bad page" }, 400);
  try {
    return await cached(`address/v2/${await sha256(addr)}/${page}`, 30, ctx, async () => {
      const o = await chainAddress(env, addr, 20, page);
      return {
        ok: true,
        balance: atomic(o.balance).toString(),
        // Blockbook reports a signed delta here when a mempool transaction spends
        // this address's confirmed outputs. Transaction values stay nonnegative.
        unconfirmed: signedAtomic(o.unconfirmedBalance ?? "0").toString(),
        txs: o.txs || 0,
        page,
        hasMore: page < (o.totalPages || 1),
        history: o.transactions.map((tx) => {
          const own = (io) => io.addresses?.includes(addr), sent = (tx.vin || []).some(own);
          const external = (sent ? tx.vout || [] : tx.vin || []).filter((io) => !own(io));
          const peer = external.reduce((best, io) => !best || atomic(io.value) > atomic(best.value) ? io : best, null);
          return {
          txid: tx.txid,
          time: tx.blockTime || 0,
          confirmations: tx.confirmations || 0,
          delta: (totalTo(tx.vout, addr) - totalTo(tx.vin, addr)).toString(),
          sent,
          amount: (sent ? external.reduce((n, io) => n + atomic(io.value), 0n) : totalTo(tx.vout, addr)).toString(),
          fee: atomic(tx.fees ?? "0").toString(),
          address: peer?.addresses?.[0] || "",
        }; }),
      };
    });
  } catch {
    return json({ ok: false, error: "upstream" }, 502);
  }
}
export const TXID_RE = /^[0-9a-f]{64}$/;
// Rows per side sent to the browser; inputCount / outputCount give the full totals.
export const TX_ROWS = 2000;
// Lookups per IP a minute, cached ones included.
export const TX_PER_IP = 5;
// Blockbook fetches a minute for all lookups together (cache misses only; reserveBudget allows 60).
// Its own budget, so a flood of lookups cannot use up the "Blockbook" one that chain income and
// network sampling share.
const TX_BUDGET = "Blockbook-tx";
// One more request named `name` for this IP this minute, or false once it has had `limit`. With the
// RL_TX rate-limit binding (wrangler.toml; its limit is TX_PER_IP = SEND_PER_IP = 5 a minute) that costs
// no D1 write, cache hits included. Without it (tests, a Worker deployed from an older wrangler.toml)
// a D1 counter does the same, under the "pb:" prefix so the hourly cleanup removes it.
async function perIP(env, name, limit, ip, t) {
  if (env.RL_TX) return (await env.RL_TX.limit({ key: `${name}:${await sha256(ip)}` })).success;
  const row = await env.DB.prepare(`INSERT INTO kv (k, v, ts) VALUES (?, '1', ?)
    ON CONFLICT(k) DO UPDATE SET v = CAST(kv.v AS INTEGER) + 1
    WHERE CAST(kv.v AS INTEGER) + 1 <= ? RETURNING v`)
    .bind(`pb:ip:${name}:${Math.floor(t / 60)}:${await sha256(ip)}`, t, limit).first();
  return !!row;
}
const txRow = (io) => {
  const addr = io.isAddress !== false && io.addresses?.length === 1 ? io.addresses[0] : null;
  return addr ? { address: addr, value: atomic(io.value ?? "0").toString() }
    // No address: an OP_RETURN data output (script starts with 0x6a) or another nonstandard script.
    : { address: null, value: atomic(io.value ?? "0").toString(), data: typeof io.hex === "string" && io.hex.startsWith("6a") };
};
/// One indexer's view of transaction `txid` (Blockbook's JSON), "missing" when it does not know it,
/// or null when it gives no usable answer (our own refuses reads with a 503 while it catches up).
async function txFrom(base, txid, headers = {}) {
  try {
    const r = await fetch(`${base}/api/v2/tx/${txid}`, {
      headers: { "user-agent": UA, accept: "application/json", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Blockbook answers an unknown txid with 400 {"error":"Transaction '…' not found"}. A 404 is never
    // that: node.pearlhub.net's gateway says {"error":"not found"} for a path it doesn't serve.
    if (r.status === 400) return /not found/i.test(String(JSON.parse((await readCapped(r, 4096)) || "{}")?.error ?? "")) ? "missing" : null;
    if (r.status !== 200) return null;
    // MAX_BODY (2 MB) holds any standard transaction: a 1,001-output payout (43 kvB) is 346 KB
    // from Blockbook, and policy caps a standard transaction at 100 kvB (about 0.8 MB here).
    const o = JSON.parse(await readCapped(r, MAX_BODY));
    return o && !o.error && o.txid === txid && Array.isArray(o.vin) && Array.isArray(o.vout) ? o : null;
  } catch {
    return null;
  }
}
const confirmationsOf = (o) => Number.isSafeInteger(o.confirmations) && o.confirmations > 0 ? o.confirmations : 0;
/// POST /v1/tx { txid } → one transaction: status, block, fee and its inputs/outputs.
/// Asks our own indexer and the official one at once (like the App) and shows the copy with more
/// confirmations: on 2026-10-20 the official indexer showed a mined transaction as unconfirmed for hours
/// while its own block listed it, and when one indexer is down the other still answers.
/// 404 when no indexer knows the transaction (not cached, so a fresh broadcast shows up);
/// 429 past TX_PER_IP lookups a minute for this IP, or past the shared budget for Blockbook fetches.
export async function tx(env, body, ctx, ip = "?") {
  const txid = typeof body?.txid === "string" ? body.txid.trim().toLowerCase() : "";
  if (!TXID_RE.test(txid)) return json({ ok: false, error: "bad txid" }, 400);
  const t = now(), busy = () => json({ ok: false, error: "busy", retry_after: 60 - (t % 60) }, 429);
  try {
    if (!(await perIP(env, TX_BUDGET, TX_PER_IP, ip, t))) return busy();
    return await cached(`tx/v1/${await sha256(txid)}`, 30, ctx, async () => {
      if (!(await reserveBudget(env.DB, TX_BUDGET, 1, t))) return busy();
      const copies = await Promise.all(indexers(env).map(([, base, headers]) => txFrom(base, txid, headers)));
      const found = copies.filter((c) => c && c !== "missing");
      if (!found.length) {
        if (copies.includes("missing")) return json({ ok: false, error: "not found" }, 404);
        throw new Error("upstream");
      }
      // The furthest along; on a tie the first, ours.
      const o = found.reduce((best, c) => confirmationsOf(c) > confirmationsOf(best) ? c : best);
      const coinbase = o.vin.some((io) => io.coinbase);
      const confirmations = confirmationsOf(o);
      return {
        ok: true,
        txid,
        confirmations,
        // A mempool transaction has no block yet (Blockbook reports height -1 or 0).
        height: confirmations && Number.isSafeInteger(o.blockHeight) && o.blockHeight > 0 ? o.blockHeight : null,
        blockHash: confirmations && typeof o.blockHash === "string" ? o.blockHash : null,
        time: Number.isSafeInteger(o.blockTime) && o.blockTime > 0 ? o.blockTime : null,
        size: Number.isSafeInteger(o.size) ? o.size : null,
        vsize: Number.isSafeInteger(o.vsize) ? o.vsize : null,
        value: atomic(o.value ?? "0").toString(),
        fee: atomic(o.fees ?? "0").toString(),
        coinbase,
        inputCount: coinbase ? 0 : o.vin.length,
        outputCount: o.vout.length,
        inputs: coinbase ? [] : o.vin.slice(0, TX_ROWS).map(txRow),
        outputs: o.vout.slice(0, TX_ROWS).map(txRow),
      };
    });
  } catch {
    return json({ ok: false, error: "upstream" }, 502);
  }
}
// ── broadcast ──
// Broadcasts per IP a minute, refused ones included.
export const SEND_PER_IP = 5;
// Policy caps a standard transaction at 400,000 weight units and every byte weighs at least one, so
// nothing the network relays is longer. The shortest possible transaction (one input and one output,
// both with empty scripts) is 60 bytes.
export const SEND_MAX_BYTES = 400_000;
const SEND_MIN_BYTES = 60;
// Relays a minute for all broadcasts together (reserveBudget allows 60), apart from the lookups' budget.
const SEND_BUDGET = "broadcast";
// Longer than a read: a reply that never arrives leaves the outcome unknown.
const SEND_TIMEOUT_MS = 15_000;
const HEX_RE = /^(?:[0-9a-f]{2})+$/;
// Error codes about the transaction itself, as Blockbook passes them on from the node (Bitcoin Core
// and btcd share them): -22 does not decode, -25 / -26 failed checks or was refused, -27 is already in
// the chain. Any other answer is the indexer's or the node's own trouble, not one about this transaction.
const TX_CODES = new Set([-22, -25, -26, -27]);
// The node has it already: in its mempool ("already have transaction", btcd) or in the chain.
const KNOWN_RE = /already have transaction|transaction already exists|already in block ?chain|txn-already-(?:known|in-mempool)/i;
// Pearl Hub's own Blockbook and pearld (prl-hub/node-gateway), which relays broadcasts even while its
// index catches up. OWN_BLOCKBOOK_BASE overrides it; an empty one leaves only the official indexer.
// Since 2026-10-20 13:19 the gateway answers only requests carrying one of its APP_KEYS in
// X-Pearl-Hub-Key (401 otherwise, which counts as no answer): the secret OWN_BLOCKBOOK_KEY.
const OWN_BLOCKBOOK = "https://node.pearlhub.net";
/// [name, base, headers] of the indexers to ask: ours (with its key), unless turned off, and the official one.
// Either setting may be given with or without the trailing /api/v2 the requests add.
const indexerBase = (base) => base.replace(/\/$/, "").replace(/\/api\/v2$/, "");
function indexers(env) {
  const official = indexerBase(env.BLOCKBOOK_BASE || "https://blockbook.pearlresearch.ai");
  const own = indexerBase(env.OWN_BLOCKBOOK_BASE ?? OWN_BLOCKBOOK);
  const key = env.OWN_BLOCKBOOK_KEY ? { "x-pearl-hub-key": env.OWN_BLOCKBOOK_KEY } : {};
  return own && own !== official ? [["own", own, key], ["official", official, {}]] : [["official", official, {}]];
}
/// One indexer's signed copy of transaction `txid` (txFrom, with its hex checked), "missing", or null.
async function indexedTx(base, txid, headers) {
  const o = await txFrom(base, txid, headers);
  if (!o || o === "missing") return o;
  const hex = typeof o.hex === "string" ? o.hex.toLowerCase() : "";
  return HEX_RE.test(hex) && hex.length >= 2 * SEND_MIN_BYTES && hex.length <= 2 * SEND_MAX_BYTES ? { hex, confirmations: confirmationsOf(o) } : null;
}
// Statuses meaning the request was turned away before it reached a node: node.pearlhub.net's gateway
// checks the key (401), the path (404), the size (413) and a per-IP rate (429) before forwarding.
const NOT_DELIVERED = new Set([401, 403, 404, 413, 429]);
/// One Blockbook's sendtx → { txid } when accepted, { code, message } with the node's error code
/// (400 { error: "-26: TX rejected: …" }), { notDelivered: true } when no node saw the request, or a
/// throw for anything else (no answer: the node may or may not have it).
async function blockbookSend(base, hex, headers = {}) {
  const r = await fetch(`${base}/api/v2/sendtx/`, {
    method: "POST", headers: { "content-type": "text/plain", accept: "application/json", "user-agent": UA, ...headers },
    body: hex, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (NOT_DELIVERED.has(r.status)) return { notDelivered: true };
  if (r.status !== 200 && r.status !== 400) throw new Error("upstream");
  const o = JSON.parse(await readCapped(r, 65536));
  const m = r.status === 400 && typeof o?.error === "string" ? /^(-\d+): ([\s\S]*)$/.exec(o.error) : null;
  if (r.status === 200 && typeof o?.result === "string" && TXID_RE.test(o.result)) return { txid: o.result };
  if (m && TX_CODES.has(Number(m[1]))) return { code: Number(m[1]), message: m[2] };
  throw new Error("upstream");
}
const isKnown = (reply) => reply.code === -27 || KNOWN_RE.test(reply.message);
/// Like the App, a broadcast goes to both indexers at once, our own and the official one: each hands it
/// to its own node, and either relays it to the network. Sending the same signed transaction twice
/// cannot spend anything twice. Accepted wins, then already known. A refusal is the verdict only when
/// every node that saw the request refused it: one that gave no answer may have relayed it (our node can
/// lack a parent the official one has), so then the outcome is unknown, as when no node answers at all.
/// A request turned away before any node saw it (NOT_DELIVERED) says nothing about the transaction.
async function relay(env, hex) {
  const replies = await Promise.all(indexers(env).map(([via, base, headers]) => blockbookSend(base, hex, headers).then((reply) => ({ ...reply, via }), () => null)));
  const best = replies.find((r) => r?.txid) || replies.find((r) => r?.code != null && isKnown(r));
  if (best) return best;
  const reached = replies.filter((r) => !r?.notDelivered);
  if (reached.length && reached.every((r) => r?.code != null)) return reached[0];
  throw new Error("upstream");
}
/// POST /v1/tx/send { hex } → broadcasts a signed raw transaction through both indexers (relay).
/// { txid } instead rebroadcasts one an indexer still has: 200 { ok, confirmed: true } without sending
/// when it is already in a block, 404 when neither indexer has it, otherwise as for { hex }.
/// 200 { ok, txid } when a node accepts it, { ok, known: true } when it has it already; 422
/// { error: "rejected", reason } with the node's message when every node that saw it refused it; 400 for
/// anything that is not hex of a plausible length; 429 past SEND_PER_IP a minute for this IP or the shared
/// budget; 502 when a node gave no answer and none accepted it (the transaction may or may not be out).
/// `via` names the indexer whose answer this is: "own" or "official".
export async function sendTx(env, body, ip = "?") {
  const byId = typeof body?.txid === "string" && body.hex === undefined;
  const txid = byId ? body.txid.trim().toLowerCase() : "";
  let hex = !byId && typeof body?.hex === "string" && body.hex.length <= 4 * SEND_MAX_BYTES ? body.hex.replace(/\s+/g, "").toLowerCase() : "";
  if (byId ? !TXID_RE.test(txid) : !HEX_RE.test(hex) || hex.length < 2 * SEND_MIN_BYTES || hex.length > 2 * SEND_MAX_BYTES)
    return json({ ok: false, error: byId ? "bad txid" : "bad transaction" }, 400);
  const t = now(), busy = () => json({ ok: false, error: "busy", retry_after: 60 - (t % 60) }, 429);
  try {
    if (!(await perIP(env, SEND_BUDGET, SEND_PER_IP, ip, t))) return busy();
    if (!(await reserveBudget(env.DB, SEND_BUDGET, 1, t))) return busy();
    if (byId) {
      // A rebroadcast: the signed transaction as an indexer still has it, in its mempool or a block.
      const copies = await Promise.all(indexers(env).map(([, base, headers]) => indexedTx(base, txid, headers)));
      const found = copies.filter((c) => c && c !== "missing");
      if (found.some((c) => c.confirmations > 0)) return json({ ok: true, confirmed: true });
      if (!found.length) return copies.includes("missing") ? json({ ok: false, error: "not found" }, 404) : json({ ok: false, error: "upstream" }, 502);
      hex = found[0].hex;
    }
    const reply = await relay(env, hex), via = reply.via;
    if (reply.txid) return json({ ok: true, txid: reply.txid, via });
    if (isKnown(reply)) return json({ ok: true, known: true, via });
    return json({ ok: false, error: "rejected", reason: `${reply.code}: ${reply.message}`.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300), via }, 422);
  } catch {
    return json({ ok: false, error: "upstream" }, 502);
  }
}
export async function priceHistory(env, ctx) {
  return cached("price/history", 60, ctx, async () => {
    const p = await env.DB.prepare(
      "SELECT ts, src FROM prices ORDER BY ts DESC LIMIT 1",
    ).first();
    if (!p) return { source: null, points: [] };
    const { results } = await env.DB.prepare(
      `SELECT ts, usd FROM prices WHERE src = ? AND ts >= ?
      AND ts IN (SELECT MAX(ts) FROM prices WHERE src = ? AND ts >= ? GROUP BY CAST(ts / 300 AS INTEGER)) ORDER BY ts`,
    )
      .bind(p.src, p.ts - 86400, p.src, p.ts - 86400)
      .all();
    return { source: p.src, points: results.map((r) => [r.ts, r.usd]) };
  });
}
