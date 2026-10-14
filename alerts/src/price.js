// PRL spot price for the alert worker.
//
// The app prices PRL off SafeTrade's public ticker, and the alerts should fire
// on that same number. The ticker reaches the worker through POST
// /v1/ingest/safetrade (bearer INGEST_TOKEN); the worker uses it while it is fresh.
//
// Fallback, and sanity reference, is the MEDIAN of three public sources that
// track SafeTrade closely (2026-09-18: SafeTrade 0.7993, CoinEx 0.7999, BigONE
// 0.8209, WhatToMine×BTC 0.789):
//
//   • CoinEx  PEARLUSDT — NB "PRLUSDT" on CoinEx is an unrelated token (~$0.11)
//   • BigONE  PRL-USDT
//   • WhatToMine exchange_rate (PRL→BTC) × BTC/USD (Kraken, Coinbase fallback)
//
// A median of three shrugs off one stale or thin market. With two sources it is
// their mean; a lone source is accepted only if it is within MAX_SOLO_JUMP of
// the last good price, so one bad print can never fire alerts on its own.

const MAX_SOLO_JUMP = 0.3;
/// A pushed SafeTrade quote older than this is ignored (pushed once a minute).
export const ST_MAX_AGE = 150;
/// …and so is one this far off the median of the other three (a broken print).
const ST_MAX_DEV = 0.25;

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

async function getJSON(url, timeoutMs = 8000) {
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "PearlHubAlerts/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function coinex() {
  const j = await getJSON("https://api.coinex.com/v2/spot/ticker?market=PEARLUSDT");
  const t = j && j.code === 0 && Array.isArray(j.data) ? j.data[0] : null;
  return t ? { last: num(t.last), open24: num(t.open) } : null;
}

async function bigone() {
  const j = await getJSON("https://big.one/api/v3/asset_pairs/PRL-USDT/ticker");
  const t = j && j.code === 0 ? j.data : null;
  return t ? { last: num(t.close), open24: num(t.open) } : null;
}

async function btcUsd() {
  // Both at once, Kraken preferred: asking Coinbase only after Kraken timed out
  // could hold the tick for two timeouts.
  const [k, c] = await Promise.all([
    getJSON("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"),
    getJSON("https://api.coinbase.com/v2/prices/BTC-USD/spot"),
  ]);
  const kp = k && k.result && k.result.XXBTZUSD && num(k.result.XXBTZUSD.c && k.result.XXBTZUSD.c[0]);
  return kp || (c && c.data ? num(c.data.amount) : null);
}

async function whattomine() {
  const [w, btc] = await Promise.all([getJSON("https://whattomine.com/coins/469.json"), btcUsd()]);
  const xr = w && num(w.exchange_rate);
  // Ignore a WhatToMine snapshot older than 30 min — it lags the market.
  const fresh = w && num(w.timestamp) && Date.now() / 1000 - w.timestamp < 1800;
  return xr && btc && fresh ? { last: xr * btc } : null;
}

export function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/// Combine source quotes into one price. `prev` is the last stored price, or
/// null when there is none or it is too old to judge a jump by (after an outage
/// the market may really have moved 30%); `st` is a fresh pushed SafeTrade
/// quote `{ last, open24 }` (or null).
/// → { usd, open24, n, src: "safetrade" | "median" } or null
export function combine(quotes, prev, st = null) {
  const lasts = Object.values(quotes).map((q) => q && q.last).filter((x) => x != null);
  const opens = Object.values(quotes).map((q) => q && q.open24).filter((x) => x != null);
  const med = median(lasts);
  if (st && num(st.last)) {
    const sane = med != null
      ? Math.abs(st.last / med - 1) <= ST_MAX_DEV
      : !prev || Math.abs(st.last / prev - 1) <= MAX_SOLO_JUMP;
    if (sane) return { usd: st.last, open24: num(st.open24) || median(opens), n: lasts.length + 1, src: "safetrade" };
  }
  if (!lasts.length) return null;
  if (lasts.length === 1 && prev && Math.abs(lasts[0] / prev - 1) > MAX_SOLO_JUMP) return null;
  return { usd: med, open24: median(opens), n: lasts.length, src: "median" };
}

/// Validate a SafeTrade ticker body as POSTed by the push script (SafeTrade's
/// own JSON: { at, ticker: { last, open, ... } }). → { last, open24, at } or null
export function parseSafeTrade(body, now) {
  const t = body && typeof body === "object" ? body.ticker : null;
  const last = t && num(t.last);
  const at = body && num(body.at);
  if (!last || !at || Math.abs(now - at) > 300) return null;
  return { last, open24: num(t.open), at };
}

export async function fetchQuotes() {
  const [cx, bo, wtm] = await Promise.all([coinex(), bigone(), whattomine()]);
  return { coinex: cx, bigone: bo, whattomine: wtm };
}
