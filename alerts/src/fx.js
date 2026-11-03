import { now, webJson as json, sharedCopy, ownCopy, shareWork, shareKey } from "./http.js";
import { readCapped, UA } from "./pools.js";
export const FX_CODES = ["CNY", "TWD", "HKD", "RUB", "VND", "IDR", "EUR", "JPY", "KRW", "GBP", "SGD", "AUD", "CAD", "BRL", "TRY", "INR", "THB"];
const FX_TTL = 12 * 3600; // seconds
const TIMEOUT_MS = 15000; // milliseconds
const validRates = (rates) => rates && FX_CODES.every((code) => typeof rates[code] === "number" && Number.isFinite(rates[code]) && rates[code] > 0);

/// D1 survives edge eviction; failed refreshes retain the last useful rate table.
async function fxTable(db) {
  const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'fx:USD'").first();
  let old;
  try { old = row && JSON.parse(row.v); } catch { old = null; }
  if (!old?.ok || old.base !== "USD" || !Number.isSafeInteger(old.ts) || !validRates(old.rates)) old = null;
  if (old && now() - row.ts < FX_TTL) return json(old);
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) throw new Error("upstream");
    const o = JSON.parse(await readCapped(res, 65536));
    if ((o.base_code != null && o.base_code !== "USD") || (o.result != null && o.result !== "success")) throw new Error("upstream");
    const rates = Object.fromEntries(FX_CODES.map((code) => [code, o.rates?.[code]]));
    if (!validRates(rates)) throw new Error("upstream");
    const data = { ok: true, ts: now(), base: "USD", rates };
    await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('fx:USD', ?, ?)").bind(JSON.stringify(data), data.ts).run();
    return json(data);
  } catch { return old ? json({ ...old, stale: true }) : json({ ok: false, error: "upstream" }, 503); }
}

/// Concurrent requests share one `fxTable` call, waiting for it at most SHARE_WAIT_MS (`shareWork`,
/// http.js), as data rather than one Response; `ctx` keeps it alive if the request that started it
/// goes away.
export async function fx(env, ctx) {
  return ownCopy(await shareWork(shareKey("fx", env.DB), ctx, async () => sharedCopy(await fxTable(env.DB))));
}
