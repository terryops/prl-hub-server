import { ADDRESS_RE } from "./chain.js";
import { readCapped, UA, MAX_BODY, TIMEOUT_MS } from "./pools.js";
import { reserveBudget } from "./poolstats.js";
import { cached, sha256, now, webJson as json } from "./http.js";

const RECENT_TTL = 60; // seconds
const TOTAL_TTL = 600; // seconds
const DAY = 86400; // seconds

/// Swift ChainIncome.legs: both gross legs are net of change.
export function legs(rows) {
  if (!Array.isArray(rows)) throw new Error("upstream");
  return rows.map((r) => {
    const number = (v) => { const n = Number(typeof v === "string" ? v : "0"); return Number.isFinite(n) ? n : 0; };
    const self = number(r.sentToSelf);
    return { t: Number.isInteger(r.time) ? r.time : 0, recv: Math.max(0, number(r.received) - self), sent: Math.max(0, number(r.sent) - self) };
  });
}
export function external(mine, others) {
  let ext = 0;
  for (const leg of mine) if (leg.recv > 0) {
    const transfer = others.some((ob) => ob.some((o) => o.t === leg.t && o.sent > 0 && Math.abs(o.sent - leg.recv) <= Math.max(2000000, leg.recv * 0.02)));
    if (!transfer) ext += leg.recv;
  }
  return ext / 1e8;
}
async function history(env, addr, lifetime, ctx) {
  const t = now(), ttl = lifetime ? TOTAL_TTL : RECENT_TTL;
  const res = await cached(`income/${lifetime ? "total" : "legs"}/${await sha256(addr)}`, ttl, ctx, async () => {
    if (!await reserveBudget(env.DB, "Blockbook", 1, t)) throw new Error("busy");
    const base = (env.BLOCKBOOK_BASE || "https://blockbook.pearlresearch.ai").replace(/\/$/, "").replace(/\/api\/v2$/, "");
    const url = `${base}/api/v2/balancehistory/${addr}?from=${t - (lifetime ? 5 * 365 : 7) * DAY}&to=${t + 60}&groupBy=${lifetime ? DAY : 1}`;
    const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) throw new Error("upstream");
    const data = legs(JSON.parse(await readCapped(response, MAX_BODY)));
    return lifetime ? { total: data.reduce((n, r) => n + r.recv, 0) / 1e8 } : { legs: data };
  });
  return res.json();
}
export async function income(env, body, ctx) {
  const addr = body?.addr, own = body?.own ?? [];
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr) || !Array.isArray(own) || own.length > 20 || own.some((a) => typeof a !== "string" || !ADDRESS_RE.test(a))) return json({ ok: false, error: "bad address" }, 400);
  try {
    const addresses = [...new Set([addr, ...own])];
    const [recent, life] = await Promise.all([
      Promise.all(addresses.map((a) => history(env, a, false, ctx))),
      history(env, addr, true, ctx),
    ]);
    const mine = recent[0].legs, others = recent.slice(1).map((r) => r.legs);
    return json({ ok: true, ts: now(), h24: external(mine.filter((r) => r.t >= now() - DAY), others), d7: external(mine, others), total: life.total });
  } catch (e) {
    return e.message === "busy" ? json({ ok: false, error: "busy" }, 429) : json({ ok: false, error: "upstream" }, 502);
  }
}
