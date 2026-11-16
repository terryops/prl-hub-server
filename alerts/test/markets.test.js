import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildMarkets, cleanTokenSymbol } from "../src/markets.js";
import { fetchQuotes } from "../src/price.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreNow();
});

test("markets: normalizes NEAR / Intents contracts, excludes wash-traded CEXes, overlays trusted CEXes and DEX liquidity", () => {
  assert.equal(cleanTokenSymbol("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"), "USDC");
  assert.equal(cleanTokenSymbol("ETH-0XDAC17F958D2EE523A2206206994597C13D831EC7.OMFT.NEAR"), "USDT");
  assert.equal(cleanTokenSymbol("WRAP.NEAR"), "wNEAR");
  assert.equal(cleanTokenSymbol("NBTC.BRIDGE.NEAR"), "BTC");
  assert.equal(cleanTokenSymbol("ZEC.OMFT.NEAR"), "ZEC");

  const snap = buildMarkets({
    ts: T0,
    cg: {
      tickers: [
        // Wash-traded tier-2/3 CEXes must be excluded regardless of reported CoinGecko volume.
        {
          base: "PEARL", target: "USDT", coin_id: "pearl-2", target_coin_id: "tether",
          market: { identifier: "bigone", name: "BigONE" },
          last: 1.51, converted_last: { usd: 1.51 }, converted_volume: { usd: 8_000_000 },
          trade_url: "https://big.one/trade/PEARL-USDT",
        },
        {
          base: "PRL", target: "USDT", coin_id: "pearl-2", target_coin_id: "tether",
          market: { identifier: "ourbit", name: "Ourbit" },
          last: 1.51, converted_last: { usd: 1.51 }, converted_volume: { usd: 2_000_000 },
          trade_url: "https://www.ourbit.com/exchange/PRL_USDT",
        },
        {
          base: "PEARL", target: "USDT", coin_id: "pearl-2", target_coin_id: "tether",
          market: { identifier: "lbank", name: "LBank" },
          last: 1.51, converted_last: { usd: 1.51 }, converted_volume: { usd: 1_500_000 },
          trade_url: "https://www.lbank.com/trade/pearl_usdt",
        },
        {
          base: "PEARL", target: "USDC", coin_id: "pearl-2", target_coin_id: "usd-coin",
          market: { identifier: "margin-trade-spot", name: "Margin Trade" },
          last: 1.51, converted_last: { usd: 1.51 }, converted_volume: { usd: 5_000 },
          trade_url: "https://margin.trade/trade",
        },
        {
          base: "PEARL", target: "USDT", coin_id: "pearl-research", target_coin_id: "tether",
          market: { identifier: "gate", name: "Gate" },
          last: 1.50, converted_last: { usd: 1.50 }, converted_volume: { usd: 2_500_000 },
          trade_url: "https://www.gate.com/trade/PEARL_USDT",
        },
        // Misattributed PRL_USDT on Gate must never pollute Pearl's markets.
        {
          base: "PRL", target: "USDT", coin_id: "pearl-research", target_coin_id: "tether",
          market: { identifier: "gate", name: "Gate" },
          last: 0.07, converted_last: { usd: 0.07 }, converted_volume: { usd: 999_999 },
          trade_url: "https://www.gate.com/trade/PRL_USDT",
        },
        {
          base: "PEARL", target: "USDT", coin_id: "pearl-research", target_coin_id: "tether",
          market: { identifier: "safe_trade", name: "SafeTrade" },
          last: 1.514, converted_last: { usd: 1.51 }, converted_volume: { usd: 2_000_000 },
          trade_url: "https://safetrade.com/exchange/PEARL-USDT",
        },
        // Inverted Near Intents pools (USDT/PEARL and bridged USDC/PEARL) merge by normalized pair.
        {
          base: "PRL.OMFT.NEAR", target: "17208628F84F5D6AD33F0DA3BBBEB27FFCB398EAC501A31BD6AD2011E36133A1",
          coin_id: "pearl-research", target_coin_id: "usdc",
          market: { identifier: "near-intents", name: "Near Intents" },
          last: 1.524, converted_last: { usd: 1.52 }, converted_volume: { usd: 400_000 },
          trade_url: null,
        },
        {
          base: "ETH-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48.OMFT.NEAR", target: "PRL.OMFT.NEAR",
          coin_id: "near-intents-bridged-usdc", target_coin_id: "pearl-research",
          market: { identifier: "near-intents", name: "Near Intents" },
          last: 0.656, converted_last: { usd: 1.52 }, converted_volume: { usd: 100_000 },
          trade_url: null,
        },
        {
          base: "PRL.OMFT.NEAR", target: "17208628F84F5D6AD33F0DA3BBBEB27FFCB398EAC501A31BD6AD2011E36133A1",
          coin_id: "pearl-research", target_coin_id: "usdc",
          market: { identifier: "ref_finance", name: "Rhea Finance" },
          last: 1.52, converted_last: { usd: 1.52 }, converted_volume: { usd: 1_100_000 },
          trade_url: "https://app.rhea.finance/",
        },
      ],
    },
    gate: [{ currency_pair: "PEARL_USDT", last: "1.5225", quote_volume: "3000000" }],
    coinbase: { price: "1.5200", volume: "1000000" }, // 1,520,000 USD
    kraken: { result: { PEARLUSD: { c: ["1.5210", "10"], v: ["10000", "300000"], p: ["1.52", "1.52"] }, last: 1 } }, // 456,000 USD
    dex: {
      pairs: [
        {
          dexId: "rhea-finance", chainId: "near",
          baseToken: { address: "prl.omft.near", symbol: "PEARL" },
          quoteToken: { address: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC" },
          priceUsd: "1.523", volume: { h24: 1_200_000 }, liquidity: { usd: 670_000 },
          url: "https://dexscreener.com/near/refv2-prl-usdc",
        },
        {
          dexId: "rhea-finance", chainId: "near",
          baseToken: { address: "oyster.v2-launchpad.justhoot.near", symbol: "OYSTER" },
          quoteToken: { address: "prl.omft.near", symbol: "PEARL" },
          priceUsd: "0.0000152", priceNative: "0.00001", volume: { h24: 500 }, liquidity: { usd: 8_000 },
          url: "https://dexscreener.com/near/refv2-oyster-prl",
        },
        {
          dexId: "rhea-finance", chainId: "near",
          baseToken: { address: "prl.omft.near", symbol: "PEARL" },
          quoteToken: { address: "wrap.near", symbol: "wNEAR" },
          priceUsd: "1.521", volume: { h24: 20_000 }, liquidity: { usd: 18_000 },
          url: "https://dexscreener.com/near/refv2-prl-wnear",
        },
      ],
    },
    safetrade: { last: 1.519 },
  });

  assert.ok(snap);
  assert.equal(snap.rows.find((r) => r.venueId === "bigone"), undefined);
  assert.equal(snap.rows.find((r) => r.venueId === "ourbit"), undefined);
  assert.equal(snap.rows.find((r) => r.venueId === "lbank"), undefined);
  assert.equal(snap.rows.find((r) => r.venueId === "margin-trade"), undefined);

  // Total = Gate 3.0M + SafeTrade 2.0M + Coinbase 1.52M + Kraken 0.456M + Rhea USDC 1.2M + Intents USDC 0.5M + Rhea wNEAR 20k + Rhea OYSTER 500 = 8,696,500
  assert.equal(snap.totalVolumeUsd24h, 8_696_500);
  assert.equal(snap.cexVolumeUsd24h, 6_976_000);
  assert.equal(snap.poolVolumeUsd24h, 1_720_500);

  const oysterPool = snap.rows.find((r) => r.id === "rhea-finance:PEARL/OYSTER");
  assert.equal(oysterPool.kind, "pool");
  assert.ok(Math.abs(oysterPool.priceUsd - 1.52) < 1e-9);

  const gateRow = snap.rows.find((r) => r.id === "gate:PEARL/USDT");
  assert.equal(gateRow.priceUsd, 1.5225);
  assert.equal(gateRow.volumeUsd24h, 3_000_000);
  assert.equal(gateRow.inAppExchange, "gate");
  assert.equal(snap.rows.find((r) => r.id === "gate:PRL/USDT"), undefined);

  const stRow = snap.rows.find((r) => r.id === "safetrade:PEARL/USDT");
  assert.equal(stRow.priceUsd, 1.519);
  assert.equal(stRow.inAppExchange, "safetrade");

  const cbRow = snap.rows.find((r) => r.id === "coinbase:PEARL/USD");
  assert.equal(cbRow.volumeUsd24h, 1_520_000);

  const krRow = snap.rows.find((r) => r.id === "kraken:PEARL/USD");
  assert.equal(krRow.volumeUsd24h, 456_000);

  const rheaUsdc = snap.rows.find((r) => r.id === "rhea-finance:PEARL/USDC");
  assert.equal(rheaUsdc.kind, "pool");
  assert.equal(rheaUsdc.volumeUsd24h, 1_200_000);
  assert.equal(rheaUsdc.liquidityUsd, 670_000);

  const intentsUsdc = snap.rows.find((r) => r.id === "near-intents:PEARL/USDC");
  assert.equal(intentsUsdc.kind, "pool");
  assert.equal(intentsUsdc.volumeUsd24h, 500_000);
  assert.equal(intentsUsdc.tradeUrl, "https://app.near-intents.org/");

  const sumShares = snap.rows.reduce((s, r) => s + r.share, 0);
  assert.ok(Math.abs(sumShares - 1) < 1e-12);
});

test("GET /v1/markets: caches for 60s in D1 under markets:v2 and serves stale snapshot on upstream outage", async () => {
  setNow(T0);
  const env = makeEnv();
  // Legacy markets:v1 containing BigONE must never be served.
  env.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('markets:v1', ?, ?)").run(
    JSON.stringify({ ok: true, schemaVersion: 1, ts: T0, rows: [{ id: "bigone:PEARL/USDT", venue: "BigONE", venueId: "bigone", volumeUsd24h: 9_000_000, share: 1 }] }),
    T0,
  );
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(String(url));
    if (u.hostname === "api.gateio.ws") {
      return Response.json([{ currency_pair: "PEARL_USDT", last: "1.52", quote_volume: "3000000" }]);
    }
    if (u.hostname === "api.exchange.coinbase.com") {
      return Response.json({ price: "1.50", volume: "1000000" });
    }
    return new Response("down", { status: 503 });
  };

  const first = await call(env, "GET", "/v1/markets");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.body.stale, false);
  assert.equal(first.body.rows.length, 2);
  assert.equal(first.body.items.length, 2);
  assert.ok(first.body.rows.every((r) => r.venueId !== "bigone"));
  assert.equal(typeof first.body.updatedAt, "string");

  const prevCalls = calls;
  setNow(T0 + 30);
  const cachedRes = await call(env, "GET", "/v1/markets");
  assert.equal(cachedRes.status, 200);
  assert.equal(calls, prevCalls); // served from D1 within TTL

  // After TTL, upstream completely down -> serves stale D1 copy with stale: true.
  setNow(T0 + 120);
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const staleRes = await call(env, "GET", "/v1/markets");
  assert.equal(staleRes.status, 200);
  assert.equal(staleRes.body.stale, true);
  assert.equal(staleRes.body.rows.length, 2);
});

test("price: Gate PEARL_USDT participates in fallback quotes while ignoring unrelated pairs", async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "api.gateio.ws") {
      assert.equal(u.searchParams.get("currency_pair"), "PEARL_USDT");
      return Response.json([{ currency_pair: "PEARL_USDT", last: "1.54", change_percentage: "10" }]);
    }
    return new Response("down", { status: 503 });
  };
  const q = await fetchQuotes();
  assert.equal(q.gate.last, 1.54);
  assert.ok(Math.abs(q.gate.open24 - 1.4) < 1e-9);
});
