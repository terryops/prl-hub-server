// Full pool adapters, ported from WidgetShared/Pools. Rates are always raw H/s.
import {
  sanitizeTarget,
  readCapped,
  UA,
  TIMEOUT_MS,
  MAX_BODY,
  SOURCES,
  normalizeWorkers,
  statsRequests,
} from "./pools.js";
import { cached, sha256, webJson as json, now } from "./http.js";
const n = (v) => {
  const x = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
};
const list = (v) => (Array.isArray(v) ? v : []);
const rows = (v) => list(v).filter((x) => x && typeof x === "object");
const sum = (xs, fn) => list(xs).reduce((s, x) => s + fn(x), 0);
const windows = ["live", "hour", "day"];
const initial = () => ({
  windows,
  rates: {},
  pending: 0,
  pendingKind: "pending",
  paid: 0,
  workers: [],
  partial: false,
});
const rateText = (s) => {
  const [v, u] = String(s || "").split(/\s+/);
  return (
    n(v) *
    ({
      "EH/S": 1e18,
      "PH/S": 1e15,
      "TH/S": 1e12,
      "GH/S": 1e9,
      "MH/S": 1e6,
      "KH/S": 1e3,
    }[u?.toUpperCase()] || 1)
  );
};
const prl = (row) => String(row.coin_type || "pearl").toLowerCase() === "pearl";

/// Parse recorded replies; optional replies may be null, never fabricate worker averages.
export function parseStats(pool, replies, t = now()) {
  const [o, extra, third] = replies;
  if (!o || typeof o !== "object") throw new Error("invalid reply");
  const s = initial();
  const identities = SOURCES[pool].parse(pool === "Pearl Fortune" ? (extra || { data: { workers: [] } }) : o, t);
  const withRates = (raw, rates) => (identities.workers || []).map((w, i) => ({ ...w, rates: rates(raw[i]) }));
  if (pool === "AlphaPool") {
    if (
      !(
        n(o.last_seen) ||
        list(o.workers).length ||
        n(o.balance_prl) ||
        n(o.total_paid_prl) ||
        n(o.estHash24hRaw)
      )
    )
      return { missing: true };
    s.rates = { hour: n(o.estHash1hRaw), day: n(o.estHash24hRaw) };
    s.pending = n(o.balance_prl);
    s.paid = n(o.total_paid_prl);
    s.workers = withRates(rows(o.workers), (w) => ({ live: rateText(w.hashrate_live), hour: rateText(w.hashrate_1h), day: rateText(w.hashrate) }));

  } else if (pool === "Lucky Pool") {
    if (!o.stats) return { missing: true };
    const st = o.stats;
    s.rates = {
      live: n(st.hashrate),
      hour: n(st.hashrateAvg?.["1h"]),
      day: n(st.hashrateAvg?.["24h"]),
    };
    s.pending = (n(st.unlocked) + n(st.locked)) / 1e8;
    s.paid = n(st.paid) / 1e8;
    s.pendingKind = "withdrawableAndUnconfirmed";
    s.workers = withRates(rows(o.workers), (w) => ({ live: n(w.hashrate), hour: n(w.hashrateAvg?.["1h"]), day: n(w.hashrateAvg?.["24h"]) }));

  } else if (pool === "HeroMiners") {
    const st = o.stats || {};
    const pending = sum(o.unconfirmed, (x) => {
      const p = typeof x === "string" ? x.split(":") : null;
      return (p ? p[7] : x.status) === "orphaned" ? 0 : n(p ? p[4] : x.reward);
    });
    const paid = sum(o.payments, (x) => n(String(x).split(":")[1]));
    if (
      !(
        n(st.hashrate) ||
        n(st.balance) ||
        n(st.paid) ||
        n(st.lastShare) ||
        list(o.workers).length ||
        pending ||
        paid
      )
    )
      return { missing: true };
    s.rates = {
      live: n(st.hashrate) * 2 ** 32,
      hour: n(st.hashrate_1h) * 2 ** 32,
      day: n(st.hashrate_24h) * 2 ** 32,
    };
    s.pending = (n(st.balance) + pending) / 1e8;
    s.paid = (n(st.paid) || paid) / 1e8;
    s.workers = withRates(rows(o.workers), (w) => ({ live: n(w.hashrate) * 2 ** 32, hour: n(w.hashrate_1h) * 2 ** 32, day: n(w.hashrate_24h) * 2 ** 32 }));

  } else if (pool === "Pearl Fortune") {
    const d = o.data,
      c = extra?.data,
      ledger = third?.data;
    if (!d) return { missing: true };
    const bal = n(d.balance?.balance_atomic),
      pend = n(d.pending_shares?.pending_estimate_amount_atomic);
    s.paid = n(ledger?.sum_payout_amount_coin);
    if (!(bal || pend || s.paid || list(c?.workers).length))
      return { missing: true };
    const live = n(c?.summary?.reported_hashrate);
    const roll = (h) =>
      n(
        list(d.hourly_shares?.rolling_hashrates).find((x) => x.hours === h)
          ?.hashrate,
      );
    const series = list(d.hourly_shares?.series).filter(
      (p) =>
        n(p.total_share_sum) > 0 &&
        p.pool_hashrate != null &&
        p.share_sum != null,
    );
    const derived =
      sum(
        series,
        (p) => (n(p.share_sum) / n(p.total_share_sum)) * n(p.pool_hashrate),
      ) / (series.length || 1);
    s.rates = { live, hour: roll(1) || live, day: roll(24) || derived || live };
    s.pending = (bal + pend) / 1e8;
    s.workers = withRates(rows(c?.workers), (w) => ({ live: n(w.reported_hashrate) }));
  } else if (pool === "PearlHash") {
    const ledger = list(o.balance_transactions).filter(prl);
    s.paid = -sum(ledger, (x) => Math.min(n(x.amount), 0));
    s.pending =
      sum(ledger, (x) => n(x.amount)) + n(o.pending_rewards?.total_pending_prl);
    if (
      !(list(o.connected_workers).length || s.pending || s.paid || ledger.length)
    )
      return { missing: true };
    s.workers = withRates(rows(o.connected_workers), (w) => ({ live: sum(w.gpu_info, (g) => n(g.hashrate)) }));
    const epoch = list(o.pending_rewards?.epochs)
      .filter((x) => prl(x) && n(x.share) > 0)
      .at(-1);
    const hour = n(epoch?.share) * n(extra?.hashrate);
    s.windows = hour > 0 ? ["live", "hour"] : ["live"];
    s.rates = {
      live: sum(s.workers, (w) => w.rates.live),
      ...(hour > 0 ? { hour } : {}),
    };
  } else if (pool === "Kryptex") {
    s.pending = n(extra?.total);
    s.paid = n(third?.paid);
    if (
      !(list(o.results).length || s.pending || s.paid || n(extra?.last_active))
    )
      return { missing: true };
    s.windows = ["m30", "h3", "day"];
    s.workers = withRates(rows(o.results), (w) => ({ m30: n(w.avg_hashrate_30m), h3: n(w.avg_hashrate_3h), day: n(w.avg_hashrate_24h) }));

  } else if (pool === "F2Pool") {
    const d = o.originData;
    if (!d) return { missing: true };
    s.windows = ["m15", "day"];
    s.rates = {
      m15: n(d.summary?.hash_rate),
      day: n(d.summary?.hash_rate_daily),
    };
    const html = typeof third === "string" ? third : "";
    const bal = n(html.match(/data-balance="?([0-9][0-9.,]*)/)?.[1]);
    const est = n(
      html
        .split("revenue-est-today-tooltip")[1]
        ?.match(/class="num"[^>]*>\s*([0-9][0-9.,]*)/)?.[1],
    );
    s.pending = bal > 0 || est <= 0 ? bal : est;
    s.pendingKind = bal > 0 || est <= 0 ? "pending" : "todayEstimate";
    s.paid = sum(extra?.data, (x) => n(x.amount));
    s.workers = withRates(rows(d.workers), (w) => ({ m15: n(w.hashrate) * 1e12, day: n(w.hashrate_last_day) * 1e12 }));
    s.partial = n(d.worker_length_all) > s.workers.length;
  } else throw new Error("unknown pool");
  const normalized = normalizeWorkers({ workers: s.workers, partial: s.partial });
  s.workers = normalized.workers;
  s.partial = normalized.partial;
  s.workers.sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return s;
}

/// Reserve all requests atomically before starting any: concurrent cache misses share a cap.
export async function reserveBudget(db, pool, count, t, ip) {
  const limit = pool === "PearlHash" ? 20 : 60;
  if (!Number.isSafeInteger(count) || count < 1 || count > limit) return false;
  const reserve = (key, cap) => db
    .prepare(
      `INSERT INTO kv (k, v, ts) VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET v = CAST(kv.v AS INTEGER) + excluded.v
    WHERE CAST(kv.v AS INTEGER) + excluded.v <= ? RETURNING v`,
    )
    .bind(key, String(count), t, cap)
    .first();
  // Charge misses, not cached reads. One caller may spend at most a third of
  // the global allowance; failing the global reservation only burns its share.
  if (ip != null && !await reserve(`pb:ip:${pool}:${Math.floor(t / 60)}:${await sha256(ip)}`, Math.floor(limit / 3))) return false;
  const row = await reserve(`pb:${pool}:${Math.floor(t / 60)}`, limit);
  return !!row;
}
export async function poolStats(env, body, ctx, ip = "?") {
  const addr = sanitizeTarget(body?.pool, body?.addr, body?.acct);
  if (!addr) return json({ ok: false, error: "bad target" }, 400);
  const pool = body.pool,
    t = now();
  try {
    return await cached(
      `pool/${encodeURIComponent(pool)}/${await sha256(addr)}`,
      pool === "PearlHash" ? 600 : 300,
      ctx,
      async () => {
        const urls = statsRequests(pool, addr);
        if (!(await reserveBudget(env.DB, pool, urls.length, t, ip)))
          throw new Error("busy");
        const replies = await Promise.allSettled(
          urls.map(async (url, i) => {
            const html = pool === "F2Pool" && i === 2;
            const r = await fetch(url, {
              headers: {
                "user-agent": UA,
                accept: html ? "text/html" : "application/json",
                ...(!html ? SOURCES[pool].headers : {}),
              },
              redirect: "manual",
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (
              i === 0 &&
              (SOURCES[pool].gone || []).includes(r.status)
            )
              return { missing: true };
            if (r.status !== 200) throw new Error("upstream");
            const text = await readCapped(r, MAX_BODY);
            return html ? text : JSON.parse(text);
          }),
        );
        if (replies[0].status === "rejected") throw new Error("upstream");
        if (replies[0].value.missing) return { ok: true, missing: true };
        const partial = replies.some((r) => r.status === "rejected");
        const s = parseStats(
          pool,
          replies.map((r) => (r.status === "fulfilled" ? r.value : null)),
          t,
        );
        // Optional failures cannot prove that an account has never existed.
        if (s.missing && partial) throw new Error("upstream");
        return {
          ok: true,
          pool,
          ts: t,
          ...s,
          ...(s.missing ? {} : { partial: partial || s.partial }),
        };
      },
    );
  } catch (e) {
    return e.message === "busy"
      ? json({ ok: false, error: "busy", retry_after: 60 - (t % 60) }, 429)
      : json({ ok: false, error: "upstream" }, 502);
  }
}
