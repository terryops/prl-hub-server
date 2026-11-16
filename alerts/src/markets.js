// Global 24h trading volume share across CEX spot markets and on-chain DEX / cross-chain pools.
//
// Sources:
//   • CoinGecko /coins/pearl-2/tickers  — broad CEX + DEX/Intents coverage (wash-traded tier-2/3 CEXes excluded)
//   • Gate API v4 PEARL_USDT            — live Gate spot ticker (NB: PRL_USDT on Gate is unrelated!)
//   • Coinbase API PEARL-USD            — live Coinbase Exchange spot ticker
//   • Kraken API PEARLUSD               — live Kraken spot ticker
//   • CoinEx API v2 PEARLUSDT           — live CoinEx spot ticker (NB: PRLUSDT on CoinEx is unrelated!)
//   • DexScreener prl.omft.near         — live NEAR Rhea Finance pools + on-chain liquidity (TVL)
//   • D1 kv 'safetrade'                 — pushed SafeTrade spot price & volume when fresh

import { now, webJson as json, sharedCopy, ownCopy, shareWork, shareKey } from "./http.js";
import { readCapped, UA } from "./pools.js";
import { ST_MAX_AGE } from "./price.js";

const MARKETS_TTL = 60; // seconds
const TIMEOUT_MS = 10_000;
const NEAR_PEARL = "prl.omft.near";

const KNOWN_CONTRACTS = {
  "prl.omft.near": "PEARL",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC",
  "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near": "USDC.e",
  "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near": "USDT.e",
  "eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": "USDC",
  "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": "USDC",
  "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": "USDC",
  "arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": "USDC",
  "eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": "USDT",
  "sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": "USDT",
  "tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near": "USDT",
  "usdt.tether-token.near": "USDT",
  "wrap.near": "wNEAR",
  "nbtc.bridge.near": "BTC",
  "btc.omft.near": "BTC",
  "zec.omft.near": "ZEC",
  "sol.omft.near": "SOL",
  "eth.omft.near": "ETH",
  "aurora": "ETH",
  "xrp.omft.near": "XRP",
  "doge.omft.near": "DOGE",
  "qtc.omft.near": "QTC",
  "tlr.omft.near": "TLR",
  "eth-0x0f38f1ce6277bdd61ad13df59ef4d77dbdbacdc8.omft.near": "TLR",
  "eth-0x0f38f1ce62776d4a0038bc6cac66877a5687383b.omft.near": "TLR",
};

const COINGECKO_TOKEN_BY_ID = {
  "tether": "USDT",
  "near-intents-bridged-usdt": "USDT",
  "usd-coin": "USDC",
  "usdc": "USDC",
  "near-intents-bridged-usdc": "USDC",
  "wrapped-near": "wNEAR",
  "near": "NEAR",
  "bitcoin": "BTC",
  "near-intents-bridged-wbtc": "BTC",
  "zcash": "ZEC",
  "near-intents-bridged-zec": "ZEC",
  "solana": "SOL",
  "near-intents-bridged-sol": "SOL",
  "ethereum": "ETH",
  "near-intents-bridged-eth": "ETH",
  "taler-2": "TLR",
  "quantus": "QTC",
};

const VENUE_ALIASES = {
  "safe_trade": { id: "safetrade", name: "SafeTrade", kind: "cex", fallbackUrl: "https://safetrade.com/exchange/PEARL-USDT" },
  "safetrade": { id: "safetrade", name: "SafeTrade", kind: "cex", fallbackUrl: "https://safetrade.com/exchange/PEARL-USDT" },
  "safe-trade": { id: "safetrade", name: "SafeTrade", kind: "cex", fallbackUrl: "https://safetrade.com/exchange/PEARL-USDT" },
  "gate": { id: "gate", name: "Gate", kind: "cex", fallbackUrl: "https://www.gate.com/trade/PEARL_USDT" },
  "gate-io": { id: "gate", name: "Gate", kind: "cex", fallbackUrl: "https://www.gate.com/trade/PEARL_USDT" },
  "gate_io": { id: "gate", name: "Gate", kind: "cex", fallbackUrl: "https://www.gate.com/trade/PEARL_USDT" },
  "bigone": { id: "bigone", name: "BigONE", kind: "cex", fallbackUrl: "https://big.one/trade/PEARL-USDT" },
  "gdax": { id: "coinbase", name: "Coinbase Exchange", kind: "cex", fallbackUrl: "https://www.coinbase.com/advanced-trade/spot/PEARL-USD" },
  "coinbase": { id: "coinbase", name: "Coinbase Exchange", kind: "cex", fallbackUrl: "https://www.coinbase.com/advanced-trade/spot/PEARL-USD" },
  "coinbase_exchange": { id: "coinbase", name: "Coinbase Exchange", kind: "cex", fallbackUrl: "https://www.coinbase.com/advanced-trade/spot/PEARL-USD" },
  "ourbit": { id: "ourbit", name: "Ourbit", kind: "cex", fallbackUrl: "https://www.ourbit.com/exchange/PRL_USDT" },
  "lbank": { id: "lbank", name: "LBank", kind: "cex", fallbackUrl: "https://www.lbank.com/trade/pearl_usdt" },
  "kraken": { id: "kraken", name: "Kraken", kind: "cex", fallbackUrl: "https://pro.kraken.com/app/trade/PEARL-USD" },
  "margin-trade-spot": { id: "margin-trade", name: "Margin Trade", kind: "cex", fallbackUrl: "https://margin.trade/trade" },
  "margin-trade": { id: "margin-trade", name: "Margin Trade", kind: "cex", fallbackUrl: "https://margin.trade/trade" },
  "margin_trade": { id: "margin-trade", name: "Margin Trade", kind: "cex", fallbackUrl: "https://margin.trade/trade" },
  "coinex": { id: "coinex", name: "CoinEx", kind: "cex", fallbackUrl: "https://www.coinex.com/en/exchange/pearl-usdt" },
  "ref_finance": { id: "rhea-finance", name: "Rhea Finance", kind: "pool", chain: "NEAR", fallbackUrl: "https://app.rhea.finance/" },
  "ref-finance": { id: "rhea-finance", name: "Rhea Finance", kind: "pool", chain: "NEAR", fallbackUrl: "https://app.rhea.finance/" },
  "rhea-finance": { id: "rhea-finance", name: "Rhea Finance", kind: "pool", chain: "NEAR", fallbackUrl: "https://app.rhea.finance/" },
  "rhea_finance": { id: "rhea-finance", name: "Rhea Finance", kind: "pool", chain: "NEAR", fallbackUrl: "https://app.rhea.finance/" },
  "near-intents": { id: "near-intents", name: "Near Intents", kind: "pool", chain: "Intents", fallbackUrl: "https://app.near-intents.org/" },
  "near_intents": { id: "near-intents", name: "Near Intents", kind: "pool", chain: "Intents", fallbackUrl: "https://app.near-intents.org/" },
};

// Tier-2/3 CEXes excluded due to persistent in-spread wash trading / tiny book depth.
export const EXCLUDED_VENUES = new Set(["bigone", "ourbit", "lbank", "margin-trade"]);

const POOL_KEYWORDS = ["swap", "dex", "rhea", "ref", "intents", "amm", "pool", "orca", "raydium", "uniswap", "pancake"];

const posNum = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

const safeHttpsUrl = (u) => {
  if (typeof u !== "string" || !u.trim()) return null;
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "https:" && parsed.hostname && !parsed.username ? parsed.toString() : null;
  } catch {
    return null;
  }
};

export function cleanTokenSymbol(raw, cgCoinId = null) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (KNOWN_CONTRACTS[lower]) return KNOWN_CONTRACTS[lower];
  if (cgCoinId && COINGECKO_TOKEN_BY_ID[String(cgCoinId).toLowerCase()]) {
    return COINGECKO_TOKEN_BY_ID[String(cgCoinId).toLowerCase()];
  }
  const omft = lower.match(/^([a-z0-9]{2,10})\.omft\.near$/);
  if (omft && !omft[1].startsWith("0x")) return omft[1].toUpperCase();
  if (/^[A-Za-z0-9]{2,12}$/.test(trimmed) && !/^[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed === "wNEAR" ? "wNEAR" : trimmed.toUpperCase();
  }
  const nearNamed = lower.match(/^([a-z0-9]{2,10})\.[a-z0-9_-]+\.near$/);
  if (nearNamed) return nearNamed[1].toUpperCase();
  return trimmed.length > 12 ? `${trimmed.slice(0, 6)}…` : trimmed.toUpperCase();
}

function isPearlSide(rawSym, cgCoinId) {
  const id = typeof cgCoinId === "string" ? cgCoinId.toLowerCase() : "";
  if (id === "pearl-2" || id === "pearl-research") return true;
  const s = typeof rawSym === "string" ? rawSym.trim().toLowerCase() : "";
  return s === "pearl" || s === "prl" || s === NEAR_PEARL;
}

function normalizeVenue(identifier, rawName) {
  const key = typeof identifier === "string" ? identifier.trim().toLowerCase() : "";
  if (VENUE_ALIASES[key]) return VENUE_ALIASES[key];
  const cleanId = key.replace(/[^a-z0-9-]+/g, "-") || "unknown";
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : cleanId;
  const lowerAll = `${cleanId} ${name.toLowerCase()}`;
  const isPool = POOL_KEYWORDS.some((kw) => lowerAll.includes(kw));
  return { id: cleanId, name, kind: isPool ? "pool" : "cex", chain: isPool ? "DEX" : null, fallbackUrl: null };
}

function inAppExchangeFor(venueId, pair) {
  if (pair !== "PEARL/USDT") return null;
  if (venueId === "safetrade") return "safetrade";
  if (venueId === "gate") return "gate";
  return null;
}

/// Pure aggregation over raw upstream payloads; exported for unit tests.
export function buildMarkets({
  cg, gate, coinex, coinbase, kraken, dex, safetrade, previousRows, ts = now(),
} = {}) {
  const byId = new Map();

  const upsert = (entry, { authoritative = false } = {}) => {
    if (!entry || !entry.venueId || !entry.pair || EXCLUDED_VENUES.has(entry.venueId)) return;
    const vol = posNum(entry.volumeUsd24h);
    if (!vol) return;
    const price = posNum(entry.priceUsd);
    const liq = posNum(entry.liquidityUsd);
    const id = `${entry.venueId}:${entry.pair}`;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, {
        id,
        venue: entry.venue,
        venueId: entry.venueId,
        kind: entry.kind === "pool" ? "pool" : "cex",
        pair: entry.pair,
        priceUsd: price,
        volumeUsd24h: vol,
        liquidityUsd: liq,
        tradeUrl: safeHttpsUrl(entry.tradeUrl) || safeHttpsUrl(entry.fallbackUrl) || null,
        inAppExchange: inAppExchangeFor(entry.venueId, entry.pair),
        chain: entry.chain || null,
        stale: !!entry.stale,
        _weightVol: price ? vol : 0,
      });
      return;
    }
    if (authoritative) {
      // Direct exchange/DEX feed overrides CoinGecko's cached snapshot for the same market.
      if (price) {
        prev.priceUsd = price;
        prev._weightVol = vol;
      }
      prev.volumeUsd24h = vol;
      if (liq) prev.liquidityUsd = liq;
      const u = safeHttpsUrl(entry.tradeUrl);
      if (u) prev.tradeUrl = u;
      prev.stale = false;
      return;
    }
    // Same venue + normalized pair across multiple fee tiers / bridged variants (e.g. Near Intents USDC, Rhea V1/V2):
    // sum 24h volume & liquidity and volume-weight the USD price.
    const nextVol = prev.volumeUsd24h + vol;
    if (price) {
      const prevWeight = prev._weightVol || 0;
      prev.priceUsd = prev.priceUsd && prevWeight > 0
        ? (prev.priceUsd * prevWeight + price * vol) / (prevWeight + vol)
        : price;
      prev._weightVol = prevWeight + vol;
    }
    if (vol > prev.volumeUsd24h && safeHttpsUrl(entry.tradeUrl)) {
      prev.tradeUrl = safeHttpsUrl(entry.tradeUrl);
    } else if (!prev.tradeUrl) {
      prev.tradeUrl = safeHttpsUrl(entry.tradeUrl) || safeHttpsUrl(entry.fallbackUrl) || null;
    }
    prev.volumeUsd24h = nextVol;
    if (liq) prev.liquidityUsd = (prev.liquidityUsd || 0) + liq;
    prev.stale = prev.stale && !!entry.stale;
  };

  const hasLiveFeed = Boolean(
    Array.isArray(cg?.tickers) || Array.isArray(gate)
    || coinex?.code === 0 || posNum(coinbase?.price) || kraken?.result
    || Array.isArray(dex?.pairs) || posNum(safetrade?.last),
  );

  // 1. CoinGecko tickers (broadest CEX + Intents + Rhea list)
  const tickers = Array.isArray(cg?.tickers) ? cg.tickers : [];
  for (const t of tickers) {
    if (!t || typeof t !== "object") continue;
    const baseIsPearl = isPearlSide(t.base, t.coin_id);
    const targetIsPearl = !baseIsPearl && isPearlSide(t.target, t.target_coin_id);
    if (!baseIsPearl && !targetIsPearl) continue;

    const venue = normalizeVenue(t.market?.identifier, t.market?.name);
    if (EXCLUDED_VENUES.has(venue.id)) continue;
    // Reject Gate's unrelated PRL_USDT if CoinGecko ever misattributes it.
    if (venue.id === "gate" && String(t.base).toUpperCase() === "PRL") continue;
    if (venue.id === "coinex" && String(t.base).toUpperCase() === "PRL") continue;

    const rawPearl = baseIsPearl ? t.base : t.target;
    const rawCounter = baseIsPearl ? t.target : t.base;
    const counterCgId = baseIsPearl ? t.target_coin_id : t.coin_id;
    const pearlSym = String(rawPearl).trim().toUpperCase() === "PRL" && venue.kind === "cex" ? "PRL" : "PEARL";
    const counterSym = cleanTokenSymbol(rawCounter, counterCgId);
    if (!counterSym || counterSym === "PEARL" || counterSym === "PRL") continue;

    const convUsd = posNum(t.converted_last?.usd);
    const rawLast = posNum(t.last);
    // Preserve 4-decimal precision on direct USD/USDT/USDC pairs when consistent with CoinGecko's USD conversion.
    let priceUsd = convUsd;
    if (baseIsPearl && rawLast && ["USD", "USDT", "USDC"].includes(counterSym)) {
      if (!convUsd || Math.abs(rawLast / convUsd - 1) < 0.05) priceUsd = rawLast;
    }

    upsert({
      venue: venue.name,
      venueId: venue.id,
      kind: venue.kind,
      chain: venue.chain || null,
      pair: `${pearlSym}/${counterSym}`,
      priceUsd,
      volumeUsd24h: posNum(t.converted_volume?.usd),
      tradeUrl: t.trade_url,
      fallbackUrl: venue.fallbackUrl,
      stale: !!t.is_stale,
    });
  }

  // 2. DexScreener verified NEAR pools for prl.omft.near (adds TVL liquidity + fresh 24h DEX volume + minor pools)
  const dexPairs = Array.isArray(dex?.pairs) ? dex.pairs : [];
  if (dexPairs.length) {
    // Group DexScreener pools by (venueId, pair) first so V1+V2 pools sum cleanly before authoritative overlay.
    const groupedDex = new Map();
    for (const p of dexPairs) {
      if (!p || typeof p !== "object") continue;
      const baseAddr = String(p.baseToken?.address || "").toLowerCase();
      const quoteAddr = String(p.quoteToken?.address || "").toLowerCase();
      const baseIsPearl = baseAddr === NEAR_PEARL;
      const quoteIsPearl = !baseIsPearl && quoteAddr === NEAR_PEARL;
      if (!baseIsPearl && !quoteIsPearl) continue;

      const vol = posNum(p.volume?.h24);
      const liq = posNum(p.liquidity?.usd);
      // Skip dust meme pools under $100 24h volume unless they hold meaningful liquidity.
      if (!vol || (vol < 100 && (!liq || liq < 5000))) continue;

      const counterToken = baseIsPearl ? p.quoteToken : p.baseToken;
      const counterAddr = String(counterToken?.address || "").toLowerCase();
      const counterSym = KNOWN_CONTRACTS[counterAddr] || cleanTokenSymbol(counterToken?.symbol) || cleanTokenSymbol(counterToken?.address);
      if (!counterSym || counterSym === "PEARL") continue;

      let pearlUsd = null;
      const pUsd = posNum(p.priceUsd);
      const pNative = posNum(p.priceNative);
      if (baseIsPearl && pUsd) pearlUsd = pUsd;
      else if (quoteIsPearl && pUsd && pNative) pearlUsd = pUsd / pNative;

      const venue = normalizeVenue(p.dexId || "rhea-finance", p.dexId === "rhea-finance" ? "Rhea Finance" : p.dexId);
      const pair = `PEARL/${counterSym}`;
      const key = `${venue.id}:${pair}`;
      const cur = groupedDex.get(key);
      if (!cur) {
        groupedDex.set(key, {
          venue: venue.name,
          venueId: venue.id,
          kind: "pool",
          chain: p.chainId ? String(p.chainId).toUpperCase() : "NEAR",
          pair,
          priceUsd: pearlUsd,
          volumeUsd24h: vol,
          liquidityUsd: liq,
          tradeUrl: p.url || venue.fallbackUrl,
          _weightVol: pearlUsd ? vol : 0,
          _topVol: vol,
        });
      } else {
        if (pearlUsd) {
          cur.priceUsd = cur.priceUsd && cur._weightVol > 0
            ? (cur.priceUsd * cur._weightVol + pearlUsd * vol) / (cur._weightVol + vol)
            : pearlUsd;
          cur._weightVol += vol;
        }
        if (vol > cur._topVol && p.url) {
          cur.tradeUrl = p.url;
          cur._topVol = vol;
        }
        cur.volumeUsd24h += vol;
        if (liq) cur.liquidityUsd = (cur.liquidityUsd || 0) + liq;
      }
    }
    for (const entry of groupedDex.values()) {
      upsert(entry, { authoritative: true });
    }
  }

  // 3. Direct CEX live overlays (Gate, CoinEx, Coinbase, Kraken, SafeTrade pushed price)
  const gateRow = Array.isArray(gate) ? gate.find((x) => x?.currency_pair === "PEARL_USDT") : null;
  if (gateRow) {
    const last = posNum(gateRow.last);
    const quoteVol = posNum(gateRow.quote_volume);
    if (last && quoteVol) {
      upsert({
        venue: "Gate",
        venueId: "gate",
        kind: "cex",
        pair: "PEARL/USDT",
        priceUsd: last,
        volumeUsd24h: quoteVol,
        tradeUrl: "https://www.gate.com/trade/PEARL_USDT",
      }, { authoritative: true });
    }
  }

  const cxRow = coinex?.code === 0 && Array.isArray(coinex.data) ? coinex.data[0] : null;
  if (cxRow) {
    const last = posNum(cxRow.last);
    const quoteVol = posNum(cxRow.value) || (last && posNum(cxRow.vol) ? posNum(cxRow.vol) * last : null);
    if (last && quoteVol) {
      upsert({
        venue: "CoinEx",
        venueId: "coinex",
        kind: "cex",
        pair: "PEARL/USDT",
        priceUsd: last,
        volumeUsd24h: quoteVol,
        tradeUrl: "https://www.coinex.com/en/exchange/pearl-usdt",
      }, { authoritative: true });
    }
  }

  if (coinbase && typeof coinbase === "object") {
    const last = posNum(coinbase.price);
    const baseVol = posNum(coinbase.volume);
    if (last && baseVol) {
      upsert({
        venue: "Coinbase Exchange",
        venueId: "coinbase",
        kind: "cex",
        pair: "PEARL/USD",
        priceUsd: last,
        volumeUsd24h: baseVol * last,
        tradeUrl: "https://www.coinbase.com/advanced-trade/spot/PEARL-USD",
      }, { authoritative: true });
    }
  }

  const krPair = kraken?.result && typeof kraken.result === "object"
    ? (kraken.result.PEARLUSD || Object.entries(kraken.result).find(([k, v]) => k !== "last" && v && typeof v === "object")?.[1])
    : null;
  if (krPair && typeof krPair === "object") {
    const last = Array.isArray(krPair.c) ? posNum(krPair.c[0]) : null;
    const baseVol24 = Array.isArray(krPair.v) ? posNum(krPair.v[1]) : null;
    const vwap24 = Array.isArray(krPair.p) ? posNum(krPair.p[1]) : null;
    if (last && baseVol24) {
      upsert({
        venue: "Kraken",
        venueId: "kraken",
        kind: "cex",
        pair: "PEARL/USD",
        priceUsd: last,
        volumeUsd24h: baseVol24 * (vwap24 || last),
        tradeUrl: "https://pro.kraken.com/app/trade/PEARL-USD",
      }, { authoritative: true });
    }
  }

  const stLast = posNum(safetrade?.last);
  const stQuoteVol = posNum(safetrade?.quoteVol);
  if (stLast && stQuoteVol) {
    upsert({
      venue: "SafeTrade",
      venueId: "safetrade",
      kind: "cex",
      pair: "PEARL/USDT",
      priceUsd: stLast,
      volumeUsd24h: stQuoteVol,
      tradeUrl: "https://safetrade.com/exchange/PEARL-USDT",
    }, { authoritative: true });
  } else {
    const stRow = byId.get("safetrade:PEARL/USDT");
    if (stRow && stLast) stRow.priceUsd = stLast;
  }

  // 4. Carry forward any non-excluded market missing from this tick's live feeds for up to 2h
  //    (prevents transient Cloudflare-POP rate-limits on CoinGecko / Coinbase / DexScreener from flickering rows).
  if (hasLiveFeed && Array.isArray(previousRows)) {
    for (const r of previousRows) {
      if (!r || typeof r !== "object" || !r.venueId || !r.pair || EXCLUDED_VENUES.has(r.venueId)) continue;
      if (byId.has(`${r.venueId}:${r.pair}`)) continue;
      upsert({
        venue: r.venue,
        venueId: r.venueId,
        kind: r.kind,
        chain: r.chain || null,
        pair: r.pair,
        priceUsd: r.priceUsd,
        volumeUsd24h: r.volumeUsd24h,
        liquidityUsd: r.liquidityUsd,
        tradeUrl: r.tradeUrl,
        stale: true,
      });
    }
    const stRow = byId.get("safetrade:PEARL/USDT");
    if (stRow && stLast) stRow.priceUsd = stLast;
  }

  const list = [...byId.values()]
    .map(({ _weightVol, ...rest }) => rest)
    .sort((a, b) => b.volumeUsd24h - a.volumeUsd24h || a.id.localeCompare(b.id));

  if (!list.length) return null;

  let totalVolumeUsd24h = 0;
  let cexVolumeUsd24h = 0;
  let poolVolumeUsd24h = 0;
  for (const r of list) {
    totalVolumeUsd24h += r.volumeUsd24h;
    if (r.kind === "pool") poolVolumeUsd24h += r.volumeUsd24h;
    else cexVolumeUsd24h += r.volumeUsd24h;
  }

  const rows = list.map((r) => ({
    ...r,
    share: totalVolumeUsd24h > 0 ? r.volumeUsd24h / totalVolumeUsd24h : 0,
  }));

  return {
    ok: true,
    schemaVersion: 1,
    ts,
    updatedAt: new Date(ts * 1000).toISOString(),
    stale: false,
    totalVolumeUsd24h,
    cexVolumeUsd24h,
    poolVolumeUsd24h,
    rows,
    items: rows,
  };
}

async function fetchJSON(url, maxBytes = 262_144, ua = UA) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": ua, accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    return JSON.parse(await readCapped(res, maxBytes));
  } catch {
    return null;
  }
}

async function readFreshSafeTrade(db, t) {
  try {
    const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'safetrade'").first();
    if (!row || t - row.ts > ST_MAX_AGE) return null;
    return JSON.parse(row.v);
  } catch {
    return null;
  }
}

async function marketsTable(db) {
  const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'markets:v2'").first();
  let old = null;
  try { old = row ? JSON.parse(row.v) : null; } catch { old = null; }
  if (!old?.ok || old.schemaVersion !== 1 || !Array.isArray(old.rows) || !old.rows.length || !Number.isSafeInteger(old.ts)) {
    old = null;
  }
  const t = now();
  if (old && t - row.ts < MARKETS_TTL) return json(old);

  const compatUa = "Mozilla/5.0 (compatible; PearlHub/1.0; +https://pearlhub.net)";
  const [cg, gate, coinex, coinbase, kraken, dex, safetrade] = await Promise.all([
    fetchJSON("https://api.coingecko.com/api/v3/coins/pearl-2/tickers?include_exchange_logo=false&depth=false", 524_288, compatUa),
    fetchJSON("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=PEARL_USDT", 65_536),
    fetchJSON("https://api.coinex.com/v2/spot/ticker?market=PEARLUSDT", 65_536),
    fetchJSON("https://api.exchange.coinbase.com/products/PEARL-USD/ticker", 65_536, compatUa),
    fetchJSON("https://api.kraken.com/0/public/Ticker?pair=PEARLUSD", 65_536),
    fetchJSON("https://api.dexscreener.com/latest/dex/tokens/prl.omft.near", 262_144, compatUa),
    readFreshSafeTrade(db, t),
  ]);

  let prevRows = old && t - old.ts < 7200 ? old.rows : null;
  if (!Array.isArray(cg?.tickers) && (!prevRows || !prevRows.some((r) => r?.venueId === "safetrade"))) {
    try {
      const legacy = await db.prepare("SELECT v, ts FROM kv WHERE k = 'markets:v1'").first();
      const parsed = legacy && t - legacy.ts < 7200 ? JSON.parse(legacy.v) : null;
      if (Array.isArray(parsed?.rows)) prevRows = [...(prevRows || []), ...parsed.rows];
    } catch { /* ignore */ }
  }

  const built = buildMarkets({
    cg, gate, coinex, coinbase, kraken, dex, safetrade,
    previousRows: prevRows,
    ts: t,
  });
  if (!built) {
    return old ? json({ ...old, stale: true }) : json({ ok: false, error: "upstream" }, 502);
  }
  await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('markets:v2', ?, ?)").bind(JSON.stringify(built), built.ts).run();
  return json(built);
}

export async function markets(env, ctx) {
  return ownCopy(await shareWork(shareKey("markets", env.DB), ctx, async () => sharedCopy(await marketsTable(env.DB))));
}
