import { now, webJson as json } from "./http.js";
import { readCapped, UA } from "./pools.js";
import { reserveBudget } from "./poolstats.js";

const TTL = 3600; // seconds
const SPANS = { "7d": 7, "30d": 30, "90d": 90 };
const building = new WeakMap();
export function parseCandles(o) {
  if (o?.code !== 0 || !Array.isArray(o.data)) throw new Error("upstream");
  return o.data.map((c) => {
    const ts = typeof c?.time === "string" ? Math.floor(Date.parse(c.time) / 1000) : NaN, close = Number(c?.close);
    if (!Number.isSafeInteger(ts) || ts <= 0 || !Number.isFinite(close) || close <= 0) throw new Error("upstream");
    return [ts, close];
  }).sort((a, b) => a[0] - b[0]);
}
/// BigONE daily close in USDT; never spliced into the native same-source 24h series.
export async function longPriceHistory(env, span, ctx) {
  if (!SPANS[span]) return json({ error: "bad span" }, 400);
  const db = env.DB;
  let work = building.get(db);
  if (!work) {
    work = (async () => {
      // A new key prevents the unrelated CoinEx PRL market from surviving the switch.
      const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'price:bigone:daily'").first();
      let old;
      try { old = row && JSON.parse(row.v); } catch { old = null; }
      if (old?.source !== "bigone" || old.market !== "PRL-USDT" || old.quote !== "USDT" || !Array.isArray(old.points) || !old.points.length || old.points.some((p) => !Array.isArray(p) || p.length !== 2 || !Number.isSafeInteger(p[0]) || p[0] <= 0 || !Number.isFinite(p[1]) || p[1] <= 0)) old = null;
      if (old && now() - row.ts < TTL) return old;
      try {
        if (!await reserveBudget(db, "BigONE-history", 1, now())) throw new Error("busy");
        const r = await fetch("https://big.one/api/v3/asset_pairs/PRL-USDT/candles?period=day1&limit=90", { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
        if (r.status !== 200) throw new Error("upstream");
        const points = parseCandles(JSON.parse(await readCapped(r, 131072)));
        if (!points.length) throw new Error("upstream");
        const data = { source: "bigone", market: "PRL-USDT", quote: "USDT", ts: now(), points };
        await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('price:bigone:daily', ?, ?)").bind(JSON.stringify(data), data.ts).run();
        return data;
      } catch { if (old) return { ...old, stale: true }; throw new Error("upstream"); }
    })();
    building.set(db, work);
    // Finish the refresh for the requests waiting on it even if this one goes away first.
    if (ctx?.waitUntil) ctx.waitUntil(work.catch(() => {}));
  }
  try { const data = await work; return json({ ...data, span, points: data.points.slice(-SPANS[span]) }); }
  catch { return json({ error: "upstream" }, 502); }
  finally { if (building.get(db) === work) building.delete(db); }
}
