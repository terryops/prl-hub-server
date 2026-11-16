import { now, webJson as json, shareWork, shareKey } from "./http.js";
import { readCapped, UA } from "./pools.js";
import { reserveBudget } from "./poolstats.js";

const TTL = 3600; // seconds
const TIMEOUT_MS = 12_000;
const CACHE_KEY = "price:daily:v2";
const SPANS = { "7d": 7, "30d": 30, "90d": 90 };
const VALID_SOURCES = new Set(["safetrade", "gate", "coinbase", "kraken", "safetrade+gate", "safetrade+coinbase", "safetrade+kraken"]);

// Immutable closed UTC daily closes on SafeTrade PEARL/USDT (2026-08-04 .. 2026-11-15),
// used strictly to backfill pre-listing history before Gate (listed 2026-10-23) or
// Coinbase / Kraken (listed 2026-11-13) accumulated a full 90-day daily series.
const SAFETRADE_CLOSED_DAILY = [
  [1785801600, 0.26], [1785888000, 0.27], [1785974400, 0.28], [1786060800, 0.26], [1786147200, 0.26],
  [1786233600, 0.27], [1786320000, 0.27], [1786406400, 0.27], [1786492800, 0.26], [1786579200, 0.26],
  [1786665600, 0.27], [1786752000, 0.27], [1786838400, 0.27], [1786924800, 0.26], [1787011200, 0.27],
  [1787097600, 0.27], [1787184000, 0.27], [1787270400, 0.28], [1787356800, 0.29], [1787443200, 0.27],
  [1787529600, 0.27], [1787616000, 0.28], [1787702400, 0.27], [1787788800, 0.3], [1787875200, 0.29],
  [1787961600, 0.27], [1788048000, 0.27], [1788134400, 0.31], [1788220800, 0.32], [1788307200, 0.33],
  [1788393600, 0.33], [1788480000, 0.36], [1788566400, 0.36], [1788652800, 0.37], [1788739200, 0.36],
  [1788825600, 0.38], [1788912000, 0.42], [1788998400, 0.47], [1789084800, 0.63], [1789171200, 0.5],
  [1789257600, 0.54], [1789344000, 0.56], [1789430400, 0.56], [1789516800, 0.62], [1789603200, 0.76],
  [1789689600, 1.07], [1789776000, 1.09], [1789862400, 0.85], [1789948800, 1.04], [1790035200, 1.41],
  [1790121600, 1.4], [1790208000, 1.28], [1790294400, 1.1], [1790380800, 1.32], [1790467200, 1.54],
  [1790553600, 1.3], [1790640000, 1.33], [1790726400, 1.21], [1790812800, 1.15], [1790899200, 1.06],
  [1790985600, 1.07], [1791072000, 1.04], [1791158400, 1.17], [1791244800, 1.13], [1791331200, 1.43],
  [1791417600, 1.35], [1791504000, 1.37], [1791590400, 1.41], [1791676800, 1.38], [1791763200, 1.53],
  [1791849600, 1.79], [1791936000, 1.9], [1792022400, 1.89], [1792108800, 1.71], [1792195200, 1.83],
  [1792281600, 1.89], [1792368000, 1.98], [1792454400, 2.14], [1792540800, 2.43], [1792627200, 2.19],
  [1792713600, 2.05], [1792800000, 1.93], [1792886400, 1.89], [1792972800, 1.81], [1793059200, 1.72],
  [1793145600, 1.87], [1793232000, 1.57], [1793318400, 1.5], [1793404800, 1.46], [1793491200, 1.52],
  [1793577600, 1.47], [1793664000, 1.46], [1793750400, 1.58], [1793836800, 1.6], [1793923200, 1.8],
  [1794009600, 1.76], [1794096000, 1.71], [1794182400, 1.63], [1794268800, 1.51], [1794355200, 1.51],
  [1794441600, 1.4], [1794528000, 1.4899], [1794614400, 1.5175], [1794700800, 1.6723],
];

function strictTimestamp(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : NaN;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : NaN;
  }
  return NaN;
}

function strictClose(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }
  return NaN;
}

function normalizePoints(rows, tsIdx, closeIdx) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("upstream");
  const byTs = new Map();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length <= Math.max(tsIdx, closeIdx)) throw new Error("upstream");
    const ts = strictTimestamp(r[tsIdx]);
    const close = strictClose(r[closeIdx]);
    if (!Number.isSafeInteger(ts) || !Number.isFinite(close)) throw new Error("upstream");
    byTs.set(ts, close);
  }
  const out = [...byTs.entries()].sort((a, b) => a[0] - b[0]);
  if (!out.length) throw new Error("upstream");
  return out;
}

/// Gate API v4 candlesticks: `[ts_sec_str, quote_vol, close_str, high, low, open, base_vol, closed]`.
export function parseGateCandles(arr) {
  return normalizePoints(arr, 0, 2);
}

/// Coinbase Exchange candles: `[ts_sec, low, high, open, close, volume]`.
export function parseCoinbaseCandles(arr) {
  return normalizePoints(arr, 0, 4);
}

/// Kraken OHLC: `{ error: [], result: { PEARLUSD: [[ts_sec, open, high, low, close, vwap, vol, count], ...], last } }`.
export function parseKrakenCandles(obj) {
  if (!obj || typeof obj !== "object" || (Array.isArray(obj.error) && obj.error.length > 0)) throw new Error("upstream");
  const res = obj.result && typeof obj.result === "object" ? obj.result : null;
  if (!res) throw new Error("upstream");
  const rows = Array.isArray(res.PEARLUSD)
    ? res.PEARLUSD
    : Object.entries(res).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1];
  return normalizePoints(rows, 0, 4);
}

/// SafeTrade k-line: `[[ts_sec, open, high, low, close, volume], ...]`.
export function parseSafeTradeCandles(arr) {
  return normalizePoints(arr, 0, 4);
}

export const parseCandles = parseGateCandles;

function validStoredHistory(o) {
  return Boolean(
    o && typeof o === "object"
    && VALID_SOURCES.has(o.source)
    && (o.liveSource == null || VALID_SOURCES.has(o.liveSource))
    && typeof o.market === "string" && o.market.length > 0
    && (o.quote === "USDT" || o.quote === "USD")
    && Number.isSafeInteger(o.ts) && o.ts > 0
    && Array.isArray(o.points) && o.points.length > 0
    && o.points.every((p) => Array.isArray(p) && p.length === 2 && Number.isSafeInteger(p[0]) && p[0] > 0 && Number.isFinite(p[1]) && p[1] > 0),
  );
}

export function mergeWithSafeTradeBackfill(livePoints, previousPoints = null) {
  if (!Array.isArray(livePoints) || !livePoints.length) throw new Error("upstream");
  if (livePoints.length >= 90) return livePoints.slice(-95);

  const firstLiveTs = livePoints[0][0];
  const lastLiveTs = livePoints.at(-1)[0];
  const firstLiveDay = Math.floor(firstLiveTs / 86400);
  const minTs = lastLiveTs - 95 * 86400;

  const byDay = new Map();
  for (const p of SAFETRADE_CLOSED_DAILY) {
    const day = Math.floor(p[0] / 86400);
    if (p[0] >= minTs && day < firstLiveDay) byDay.set(day, p);
  }
  if (Array.isArray(previousPoints)) {
    for (const p of previousPoints) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      const day = Math.floor(p[0] / 86400);
      if (p[0] >= minTs && day < firstLiveDay && Number.isSafeInteger(p[0]) && Number.isFinite(p[1]) && p[1] > 0) {
        byDay.set(day, p);
      }
    }
  }

  const prefix = [...byDay.values()].sort((a, b) => a[0] - b[0]);
  return [...prefix, ...livePoints].slice(-95);
}

async function fetchUpstreamCandles(t) {
  const candidates = [
    {
      liveSource: "gate",
      market: "PEARL/USDT",
      quote: "USDT",
      url: "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=PEARL_USDT&interval=1d&limit=90",
      parse: parseGateCandles,
    },
    {
      liveSource: "coinbase",
      market: "PEARL/USD",
      quote: "USD",
      url: "https://api.exchange.coinbase.com/products/PEARL-USD/candles?granularity=86400",
      parse: parseCoinbaseCandles,
    },
    {
      liveSource: "kraken",
      market: "PEARL/USD",
      quote: "USD",
      url: "https://api.kraken.com/0/public/OHLC?pair=PEARLUSD&interval=1440",
      parse: parseKrakenCandles,
    },
    {
      liveSource: "safetrade",
      market: "PEARL/USDT",
      quote: "USDT",
      url: `https://safetrade.com/api/v2/trade/public/markets/pearlusdt/k-line?period=1440&time_from=${t - 95 * 86400}&time_to=${t}&limit=95`,
      parse: parseSafeTradeCandles,
    },
  ];

  for (const c of candidates) {
    try {
      const r = await fetch(c.url, {
        headers: { "user-agent": UA, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status !== 200) continue;
      const points = c.parse(JSON.parse(await readCapped(r, 131072)));
      if (points.length > 0) return { ...c, points };
    } catch {
      // Try next trusted exchange.
    }
  }
  throw new Error("upstream");
}

async function readFreshPushedSafeTradeDaily(db, t) {
  try {
    const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'safetrade:daily'").first();
    if (!row || t - row.ts >= TTL) return null;
    const parsed = JSON.parse(row.v);
    return validStoredHistory(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sliceReply(data, span) {
  const points = data.points.slice(-SPANS[span]);
  const liveSource = data.liveSource || data.source;
  const usedBackfill = points.length > 0
    && Number.isSafeInteger(data.liveFromTs)
    && points[0][0] < data.liveFromTs
    && liveSource !== "safetrade";
  const source = usedBackfill ? `safetrade+${liveSource}` : liveSource;
  const out = {
    source,
    market: data.market,
    quote: data.quote,
    ts: data.ts,
    span,
    points,
  };
  if (data.stale) out.stale = true;
  return out;
}

/// Trusted exchange daily close (SafeTrade / Gate / Coinbase / Kraken); never spliced into the 24h series.
export async function longPriceHistory(env, span, ctx) {
  if (!SPANS[span]) return json({ error: "bad span" }, 400);
  const db = env.DB;
  const work = shareWork(shareKey("daily-price", db), ctx, async () => {
    const row = await db.prepare(`SELECT v, ts FROM kv WHERE k = '${CACHE_KEY}'`).first();
    let old = null;
    try { old = row && JSON.parse(row.v); } catch { old = null; }
    if (!validStoredHistory(old)) old = null;
    const t = now();
    if (old && t - row.ts < TTL) return old;

    const pushed = await readFreshPushedSafeTradeDaily(db, t);
    if (pushed) {
      const merged = mergeWithSafeTradeBackfill(pushed.points, old?.points);
      const data = {
        source: "safetrade",
        liveSource: "safetrade",
        liveFromTs: pushed.points[0][0],
        market: "PEARL/USDT",
        quote: "USDT",
        ts: pushed.ts,
        points: merged,
      };
      await db.prepare(`INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('${CACHE_KEY}', ?, ?)`).bind(JSON.stringify(data), data.ts).run();
      return data;
    }

    try {
      if (!await reserveBudget(db, "daily-price-history", 1, t)) throw new Error("busy");
      const live = await fetchUpstreamCandles(t);
      const ts = now();
      const merged = mergeWithSafeTradeBackfill(live.points, old?.points);
      const data = {
        source: live.liveSource,
        liveSource: live.liveSource,
        liveFromTs: live.points[0][0],
        market: live.market,
        quote: live.quote,
        ts,
        points: merged,
      };
      await db.prepare(`INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('${CACHE_KEY}', ?, ?)`).bind(JSON.stringify(data), data.ts).run();
      return data;
    } catch {
      if (old) return { ...old, stale: true };
      throw new Error("upstream");
    }
  });
  try {
    const data = await work;
    return json(sliceReply(data, span));
  } catch {
    return json({ error: "upstream" }, 502);
  }
}
