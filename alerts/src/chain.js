// Blockbook access shared by read-only balances and the payment reconciler.
import { readCapped, UA, TIMEOUT_MS, MAX_BODY } from "./pools.js";
import { cached, sha256, webJson as json } from "./http.js";
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
