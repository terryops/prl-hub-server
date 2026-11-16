// Address-free pool comparison and network yield. Mirrors LordOfPearls / PoolsOverview.
import { readCapped, MAX_BODY } from "./pools.js";
import { cached, webJson as json, now } from "./http.js";
import { reserveBudget } from "./poolstats.js";
import { attachRealFees, readRealFees } from "./realfees.js";
import { recordPPLNSSnapshot, readPoolLuck, attachLuck } from "./pplns.js";

export const WORK = 2 ** 48;
const num = (v) =>
  ["number", "string"].includes(typeof v) &&
  v !== "" &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
const positive = (v) => (num(v) > 0 ? num(v) : null);
const count = (v) =>
  num(v) !== null && num(v) >= 0 ? Math.floor(num(v)) : null;
const median = (xs) => {
  const a = xs
    .map(positive)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};
const elements = (tag, s) =>
  [
    ...s.matchAll(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi"),
    ),
  ].map((m) => m[1]);
const decode = (s) =>
  s.replace(
    /&(amp|lt|gt|quot|#39|nbsp|mdash|ndash|middot);/g,
    (_, k) =>
      ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
        nbsp: " ",
        mdash: "—",
        ndash: "–",
        middot: "·",
      })[k],
  );
const text = (s) =>
  decode(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const scheme = (s) =>
  s && !["—", "-"].includes(s) ? s.split("|")[0].split("%")[0] : null;
const safeURL = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
};
const names = {
  "alphapool.tech": "AlphaPool",
  "luckypool.io": "Lucky Pool",
  "herominers.com": "HeroMiners",
  "pearlhash.xyz": "PearlHash",
  "pearlfortune.org": "Pearl Fortune",
  "f2pool.com": "F2Pool",
  "kryptex.network": "Kryptex",
  "kryptex.com": "Kryptex",
  "2miners.com": "2Miners",
  "akoyapool.com": "AkoyaPool",
  "jetskipool.ai": "Jetski",
  "peryn.ai": "Peryn",
};
/// Payout addresses the explorer leaves unlabeled, each checked against the pool's own
/// block list (every block it reports pays this address) or, for a pool without one, the
/// pool's tag in the coinbase. Never inferred from volume.
const POOL_ADDRESSES = {
  // pearl.jetskipool.ai/api/stats recent_blocks_found ↔ the explorer's block miners, 2026-10-16.
  prl1pgr2znrzz8nwu2lrw4phrzaqqa8ukt76qsqc29wxgcwgalanur7zsk8w070: "https://pearl.jetskipool.ai/",
  // F2Pool lists no PRL blocks ("This currency has no block data"). Blocks 131130–131330
  // (2026-10-21): every block whose coinbase ends "/F2Pool/" pays this address, and every
  // block paid to it carries that tag.
  prl1prsmhnjnphz4ll4v9lhg8nhr0tv3v7g8sl6qkuyqmnwkq7rhs9c2qqak0rr: "https://www.f2pool.com/",
};
const poolURL = (entry, address) => entry?.pool?.url || (Object.hasOwn(POOL_ADDRESSES, address || "") ? POOL_ADDRESSES[address] : null);
// Pearl Fortune quotes its PPS fee apart from the summary (/api/v1/stats/pool-fee-rate: 4% on
// 2026-10-23, 5% before). This is the figure when that read fails.
const FORTUNE_PPS_FEE = 4;
// F2Pool merge-mines NOCK for its PRL miners since 2026-10-21 (NOCK on PPLNS with a 1% fee, paid
// to a NOCK address set in the account), worth about 1–2% of the PRL income (owner's estimate,
// 2026-10-23). A label beside the fee: yield and Real Cost leave it out.
const MERGE_BONUS = { F2Pool: { coin: "NOCK", minPercent: 1, maxPercent: 2 } };
const pretty = (url, fallback) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      Object.entries(names).find(
        ([k]) => h === k || h.endsWith("." + k),
      )?.[1] || fallback
    );
  } catch {
    return fallback;
  }
};
export function parseTable(html) {
  const table = html.match(
    /<table\b[^>]*section-table[^>]*>([\s\S]*?)<\/table>/i,
  )?.[1];
  if (!table) return [];
  const headers = elements("th", table).map((s) => text(s).toLowerCase());
  const col = (name) => {
    const exact = headers.indexOf(name);
    return exact >= 0 ? exact : headers.findIndex((h) => h.includes(name));
  };
  const cp = col("pool"),
    ch = col("hashrate");
  if (cp < 0 || ch < 0 || col("blocks") < 0) return [];
  return elements("tr", table).flatMap((r) => {
    const cells = elements("td", r);
    if (!cells[cp]) return [];
    const get = (k) => text(cells[col(k)] || "");
    const name = text(elements("a", cells[cp])[0] || cells[cp]).slice(0, 80);
    const url = safeURL(
      decode(cells[cp].match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || ""),
    );
    const hash = get("hashrate").match(/^([\d.,]+)\s*(E|P|T|G|M|K)?H\/s\b/i);
    const hps = hash
      ? Number(hash[1].replace(/,/g, "")) *
        ({ E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, K: 1e3 }[
          hash[2]?.toUpperCase()
        ] || 1)
      : null;
    return name
      ? [
          {
            name: pretty(url, name),
            url,
            hashrate: hps,
            miners: count(get("miners").replace(/,/g, "")),
            blocks: count(get("blocks").replace(/,/g, "")),
            fee: num(get("fee").replace("%", "")),
            scheme: scheme(get("payout")),
          },
        ]
      : [];
  });
}

/// The public explorer still provides attributed 24h blocks when its HTML table is
/// unreachable. Keep only identified pool URLs; never guess a pool from an address.
export function chainPoolRows(chain) {
  const board = chain?.leaderboard;
  if (!Array.isArray(board?.top) || (positive(board.window) || 24) !== 24 ||
      !String(board.window_unit || "hours").startsWith("hour")) return [];
  const pools = new Map();
  for (const entry of board.top) {
    const url = safeURL(poolURL(entry, entry?.address)), blocks = count(entry?.blocks);
    if (!url || blocks == null) continue;
    const key = new URL(url).hostname.toLowerCase();
    const existing = pools.get(key);
    if (existing) existing.blocks += blocks;
    else pools.set(key, { name: pretty(url, entry.pool?.name || key), url, blocks,
      hashrate: null, fee: null, scheme: null, miners: null });
  }
  return [...pools.values()];
}
/// Peryn (peryn.ai), listed by neither the explorer's table nor miningpoolstats on 2026-11-02, read
/// from its own app.peryn.ai/api/pool/live: its 10-minute hashrate (accepted share difficulty × 2^64 /
/// 0xffff per second, pearld's CalcWork, the 2^48 a unit of difficulty takes), the addresses that sent
/// shares in the last hour (the "miners" of its own stats page), its fee and scheme, and the blocks it
/// lists (`foundAt`; orphaned and rejected ones left out). It pays PPLNS or PPS+ (its default, `fpps`
/// in the API), 1% each on 2026-11-02; its Founding Miners' fees: PERYN_FOUNDING.
const PERYN_URL = "https://peryn.ai/";
const PERYN_STATS = "https://app.peryn.ai/api/pool/live";
// Its Founding Miner terms (peryn.ai/mine, 2026-11-02): PPS+ 0.5%, PPLNS 0% until Pearl's FP8 upgrade and for 6
// months after it; an ⓘ beside the fee, never in yield or Real Cost. Sign-ups close on 8 Nov 2026 (Peryn's founder,
// 2026-11-05) and registered addresses keep the terms. While its peryn.ai/api/live says
// `launch.foundingRegistration` is "open" they ride as `founding` with the closing day; once it says anything else
// or the day is over, as `foundingClosed` (a new field: 2.1.11 apps read `founding` as open sign-ups).
const PERYN_LAUNCH = "https://peryn.ai/api/live";
const PERYN_FOUNDING = { "PPS+": { fee: 0.5 }, PPLNS: { fee: 0, afterFP8Months: 6 } };
const PERYN_FOUNDING_CLOSES = "2026-11-08";
const PERYN_FOUNDING_CLOSED = Date.parse(`${PERYN_FOUNDING_CLOSES}T24:00:00Z`) / 1000;
const perynPercent = (v) => (num(v) != null && num(v) >= 0 && num(v) <= 100 ? num(v) : null);
// Its 7-day trend and average, which miningpoolstats gives the other pools: `history` holds one hashrate per UTC day
// (the day's average; today's so far) and `hourly` the last 25 hours. The trend takes each day at its noon until the
// hours begin, then the hours at their half past; the average weighs the last 7 × 24 hours by day, today by the part
// of it that has passed and the eighth day back by the rest (fewer days, fewer weights: a pool younger than a week).
const perynDay = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) / 1000 : NaN);
const perynHour = (h) => (typeof h === "string" ? Date.parse(h) / 1000 : NaN);
export function perynHistory(o, t = now()) {
  const sorted = (rows, at) => (Array.isArray(rows) ? rows : [])
    .map((r) => ({ ts: at(r), hashrate: num(r?.hashrate) }))
    .filter((p) => Number.isFinite(p.ts) && p.ts > 0 && p.ts <= t && p.hashrate != null && p.hashrate >= 0)
    .sort((a, b) => a.ts - b.ts);
  const days = sorted(o?.history, (r) => perynDay(r?.day)), hours = sorted(o?.hourly, (r) => perynHour(r?.hour));
  const firstHour = hours[0]?.ts ?? Infinity;
  const points = [...days.filter((d) => d.ts + 43200 < firstHour).map((d) => ({ ts: d.ts + 43200, hashrate: d.hashrate })),
    ...hours.map((h) => ({ ts: h.ts + 1800, hashrate: h.hashrate }))];
  const end = points.at(-1)?.ts ?? 0;
  let weight = 0, sum = 0;
  const today = days.at(-1);
  if (today && today.ts > t - 86400) {
    const passed = Math.min(Math.max((t - today.ts) / 86400, 0), 1);
    for (const d of days) {
      const back = (today.ts - d.ts) / 86400;
      const w = back === 0 ? passed : back < 7 ? 1 : back === 7 ? 1 - passed : 0;
      weight += w; sum += w * d.hashrate;
    }
  }
  return { history: points.filter((p) => p.ts >= end - 7 * 86400), averageHashrate7d: weight >= 1 ? sum / weight : null };
}
// Its blocks over the last 24 hours. `blocks.recent` lists only its newest 10: once all 10 fall inside the day the list
// no longer reaches back 24 hours (2026-11-09: it showed 10 where it had found 15, Peryn: "our 24h blocks count is
// stuck?"). The rest of the day then comes from `hourly` (blocks per UTC hour, the last 25): what the hour of the
// oldest listed block holds beyond the listed ones, and every earlier hour whose middle is inside the day.
export function perynBlocks24h(blocks, hourly, t = now()) {
  const recent = Array.isArray(blocks?.recent) ? blocks.recent : null;
  if (!recent) return null;
  const time = (b) => (typeof b?.foundAt === "string" ? Date.parse(b.foundAt) / 1000 : NaN);
  const listed = recent.map(time).filter((s) => Number.isFinite(s) && s > 0 && s <= t + 60);
  const kept = recent.filter((b) => !/^(orphan|reject)/i.test(typeof b?.status === "string" ? b.status : ""))
    .map(time).filter((s) => Number.isFinite(s) && s > 0 && s <= t + 60);
  const day = t - 86400, inDay = kept.filter((s) => s > day).length;
  if (!listed.length || Math.min(...listed) <= day) return inDay;
  const hours = (Array.isArray(hourly) ? hourly : []).map((h) => ({ ts: typeof h?.hour === "string" ? Date.parse(h.hour) / 1000 : NaN, n: count(h?.blocks) }))
    .filter((h) => Number.isFinite(h.ts) && h.ts % 3600 === 0 && h.n != null);
  const cut = Math.floor(Math.min(...listed) / 3600) * 3600;
  // Without the hours before the list began, the listed day is all there is to count.
  if (!hours.some((h) => h.ts < cut && h.ts + 1800 > day)) return inDay;
  const sameHour = hours.find((h) => h.ts === cut)?.n ?? 0;
  const before = hours.filter((h) => h.ts < cut && h.ts + 1800 > day).reduce((total, h) => total + h.n, 0);
  return inDay + Math.max(0, sameHour - listed.filter((s) => s >= cut && s < cut + 3600).length) + before;
}
export function perynPool(o, t = now()) {
  const pool = o?.pool, blocks = o?.blocks;
  const hashrate = positive(pool?.hashrate?.macsPerSecond);
  if (!pool || typeof pool !== "object" || hashrate == null) return null;
  const recent = Array.isArray(blocks?.recent) ? blocks.recent : null;
  const times = (recent || [])
    .filter((b) => !/^(orphan|reject)/i.test(typeof b?.status === "string" ? b.status : ""))
    .map((b) => (typeof b?.foundAt === "string" ? Date.parse(b.foundAt) / 1000 : NaN))
    .filter((s) => Number.isFinite(s) && s > 0 && s <= t + 60);
  const found = count(blocks?.found);
  const lost = (count(blocks?.byStatus?.orphaned) ?? 0) + (count(blocks?.byStatus?.rejected) ?? 0);
  const own = typeof pool.scheme === "string" ? scheme(pool.scheme.trim().toUpperCase()) : null;
  const ppsFee = pool.fpps?.active === true ? perynPercent(pool.fpps.feePct) : null;
  return {
    name: "Peryn",
    url: PERYN_URL,
    hashrate,
    miners: count(pool.minersLastHour),
    blocks: recent ? perynBlocks24h(blocks, o?.hourly, t) : found === 0 ? 0 : null,
    fee: own || ppsFee == null ? perynPercent(pool.feePct) : ppsFee,
    scheme: own || (ppsFee != null ? "PPS+" : null),
    // PPS+ beside a shared-reward scheme; a pool whose own scheme is PPS already says it.
    ppsFee: own && !/^(PPS|FPPS)/i.test(own) ? ppsFee : null,
    lifetimeBlocks: found != null && found >= lost ? found - lost : null,
    lastBlockTime: times.length ? Math.max(...times) : null,
    ...perynHistory(o, t),
  };
}
export function averageDifficulty(o, days) {
  const live = positive(o?.network?.difficulty),
    t = positive(o?.ts);
  if (!live || !t) return null;
  const series = (
    Array.isArray(o.lifetime?.hashrate_series) ? o.lifetime.hashrate_series : []
  )
    .filter((p) => positive(p?.t) && positive(p?.diff) && p.t <= t)
    .sort((a, b) => a.t - b.t);
  if (!series.length) return null;
  const start = t - days * 86400,
    before = series.filter((p) => p.t <= start).at(-1),
    after = series.find((p) => p.t > start);
  const pts = series
    .filter((p) => p.t > start && p.t < t)
    .map((p) => ({ t: p.t, diff: p.diff }));
  if (before) {
    const next = after || { t, diff: live };
    pts.unshift({
      t: start,
      diff:
        before.diff +
        ((next.diff - before.diff) * (start - before.t)) /
          (next.t - before.t || 1),
    });
  }
  pts.push({ t, diff: live });
  let total = 0,
    span = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt > 0) {
      total += ((pts[i].diff + pts[i - 1].diff) / 2) * dt;
      span += dt;
    }
  }
  return span > 0 ? total / span : live;
}
export function parseNetwork(o) {
  if (!o?.network) return null;
  const difficulty = positive(o.network.difficulty),
    reward = median(
      (Array.isArray(o.leaderboard?.recent_blocks)
        ? o.leaderboard.recent_blocks
        : []
      ).map((b) => b?.reward),
    );
  const hours = String(o.leaderboard?.window_unit || "hours").startsWith("hour")
    ? positive(o.leaderboard?.window) || 24
    : 24;
  const blocks = positive(o.leaderboard?.total_blocks),
    measured = blocks ? (hours * 3600) / blocks : null;
  const blockTime =
    measured >= 30 && measured <= 3600
      ? measured
      : positive(o.network.avg_block_time_s);
  const hashrate =
    difficulty && blockTime
      ? (difficulty * WORK) / blockTime
      : positive(o.network.networkhashps);
  if (!hashrate && !difficulty) return null;
  return {
    source: "lordofpearls",
    ts: positive(o.ts) || now(),
    difficulty,
    hashrate,
    blockTime,
    reward,
    prlPerTHDay:
      reward && difficulty
        ? (reward * 86400 * 1e12) / (difficulty * WORK)
        : reward && hashrate && blockTime
          ? (reward * 86400 * 1e12) / (hashrate * blockTime)
          : null,
    difficulty24h: averageDifficulty(o, 1),
    difficulty3d: averageDifficulty(o, 3),
    difficulty7d: averageDifficulty(o, 7),
  };
}
function mpsNetwork(m, k) {
  const hash = Math.max(
      positive(m?.nethash_estimat) || 0,
      positive(m?.poolshash) || 0,
    ),
    blockTime = positive(m?.block_time_average);
  const reward =
    positive(m?.supply?.emission24) && blockTime
      ? (num(m.supply.emission24) * blockTime) / 86400
      : positive(k?.block_reward);
  if (!hash || !blockTime) return null;
  return {
    source: "miningpoolstats",
    ts: positive(m.time) || now(),
    hashrate: hash,
    blockTime,
    reward,
    difficulty: (hash * blockTime) / WORK,
    prlPerTHDay: reward ? (reward * 86400 * 1e12) / (hash * blockTime) : null,
    difficulty24h: null,
    difficulty3d: null,
    difficulty7d: null,
  };
}
/// prlscan.com's count of each pool's blocks over the last 24 hours (api.prlscan.com/v1/pools, read 2026-11-10: 27
/// pools, each counted on the chain by the address its blocks pay, the reply refreshed every 30 s). The 24h blocks
/// column, and the yield that follows from it, take its count wherever it lists the pool (owner, 2026-11-10); a pool
/// it doesn't list, a SOLO row (its blocks pay the miner) or a reply older than PRLSCAN_MAX_AGE keeps the table's.
const PRLSCAN_POOLS = "https://api.prlscan.com/v1/pools";
const PRLSCAN_MAX_AGE = 1800;
export function prlscanBlocks(o, t = now()) {
  const at = typeof o?.updated_at === "string" ? Date.parse(o.updated_at) / 1000 : NaN;
  if (!Number.isFinite(at) || at > t + 300 || t - at > PRLSCAN_MAX_AGE || !Array.isArray(o.items)) return [];
  return o.items.flatMap((p) => {
    const url = safeURL(p?.website_url), blocks = p?.blocks_24h;
    return url && Number.isSafeInteger(blocks) && blocks >= 0 ? [{ url, blocks }] : [];
  });
}
// A row's prlscan entry: the one on the same host, else the one pool of the same name (Kryptex is pool.kryptex.com
// there, prl.kryptex.network here); none when two could be it.
function prlscanFor(scan, url) {
  if (!safeURL(url)) return null;
  const host = (u) => new URL(u).hostname.toLowerCase();
  const same = scan.filter((p) => samePool(p.url, url)), exact = same.filter((p) => host(p.url) === host(url));
  return exact.length === 1 ? exact[0].blocks : !exact.length && same.length === 1 ? same[0].blocks : null;
}
export function buildOverview(
  rows,
  network,
  { hero = null, lucky = null, kryptex = null, mps = null, chain = null, fortune = null, fortuneFees = null, peryn = null, perynLaunch = null, prlscan = null } = {},
) {
  const scan = prlscanBlocks(prlscan);
  // Peryn from its own API, unless the table already lists it (then that row takes its terms).
  const perynData = perynPool(peryn);
  const registration = perynLaunch?.launch?.foundingRegistration;
  const foundingClosed = now() >= PERYN_FOUNDING_CLOSED || (typeof registration === "string" && registration !== "open");
  const foundingOpen = !foundingClosed && registration === "open";
  const normalized = [...rows.map((r) => ({
    ...r,
    sampleDays: 1,
    source: "lordofpearls",
  })), ...(perynData && !rows.some((p) => samePool(p.url, perynData.url)) ? [{ ...perynData, sampleDays: 1, source: "pool" }] : [])];
  const mpsDays = positive(mps?.block_time_average)
    ? (1000 * num(mps.block_time_average)) / 86400
    : null;
  const extra = (Array.isArray(mps?.data) ? mps.data : [])
    .filter(
      (r) =>
        positive(r?.hashrate) &&
        safeURL(r.url) &&
        !normalized.some(
          (p) =>
            p.url.replace(/\/$/, "") === safeURL(r.url).replace(/\/$/, "") ||
            (p.name === pretty(r.url, "") &&
              !r.url.toLowerCase().includes("solo")),
        ),
    )
    .map((r) => ({
      name: pretty(r.url, r.pool_id || new URL(safeURL(r.url)).hostname),
      url: safeURL(r.url),
      hashrate: positive(r.hashrate),
      miners: count(r.miners),
      blocks: count(r.blocks_1000),
      fee: num(r.fee),
      scheme: scheme(r.feetype),
      sampleDays: mpsDays,
      source: "miningpoolstats",
    }));
  const all = [...normalized, ...extra];
  return all
    .map((r) => {
      const solo =
        (r.scheme || "").toUpperCase() === "SOLO" ||
        r.url.toLowerCase().includes("solo");
      let hash = r.hashrate,
        fee = r.fee,
        payout = r.scheme,
        hashFromPoolAPI = false,
        feeFromPoolAPI = false;
      if (r.name === "HeroMiners" && hash == null) {
        hash =
          positive(hero?.pool?.realHashrate) ||
          (positive(hero?.pool?.hashrate)
            ? num(hero.pool.hashrate) * 2 ** 32
            : null);
        hashFromPoolAPI = hash != null;
      }
      if (r.name === "Kryptex" && !solo && kryptex) {
        payout = scheme(kryptex.fee_type) || payout;
        fee = num(kryptex.fee) != null ? num(kryptex.fee) * 100 : fee;
        if (!(hash > 0)) {
          hash = positive(kryptex.hashrate);
          hashFromPoolAPI = hash != null;
        }
        feeFromPoolAPI = true;
      }
      // HeroMiners' own config names its scheme and fee: "prop" and 0 on 2026-10-20, while the
      // pool table said PPLNS. A SOLO row keeps its own terms.
      if (r.name === "HeroMiners" && !solo && hero?.config) {
        const own = typeof hero.config.rewardScheme === "string" ? scheme(hero.config.rewardScheme.trim().toUpperCase()) : null;
        const ownFee = num(hero.config.fee);
        if (own) payout = own;
        if (ownFee != null && ownFee >= 0 && ownFee <= 100) { fee = ownFee; feeFromPoolAPI = true; }
      }
      // Lucky Pool's own config names its payout and fee: "prop" and 1 on 2026-11-02 (its site shows "PROP"),
      // while the pool table said PPLNS. A SOLO row keeps its own terms.
      if (r.name === "Lucky Pool" && !solo && lucky?.config) {
        const own = typeof lucky.config.paymentMode === "string" ? lucky.config.paymentMode.trim().toUpperCase() : "";
        const ownFee = num(lucky.config.fee);
        if (own === "PROP" || own === "PPLNS") payout = own;
        if (ownFee != null && ownFee >= 0 && ownFee <= 100) { fee = ownFee; feeFromPoolAPI = true; }
      }
      // PearlHash's API names neither. Its account API, 2026-10-31: each UTC hour's blocks are shared by
      // that hour's shares (PROP by the hour). The fee is its site's "1% pool fee" (owner, 2026-11-01),
      // though its hours paid out 99.9% of their coinbases that week. WildRig: see MINER_REPORT (realfees.js).
      if (r.name === "PearlHash") { fee = 1; if (!solo) payout = "PROP"; }
      // Peryn's own API names its scheme and fee, and is where its own row's hashrate comes from.
      const isPeryn = r.name === "Peryn" && !solo && !!perynData;
      if (isPeryn) {
        if (r.source === "pool" || !(hash > 0)) { hash = perynData.hashrate; hashFromPoolAPI = true; }
        if (perynData.scheme) payout = perynData.scheme;
        if (perynData.fee != null) { fee = perynData.fee; feeFromPoolAPI = true; }
      }
      const isFortune = r.name === "Pearl Fortune" && !solo;
      let ppsFee = FORTUNE_PPS_FEE;
      if (isFortune) {
        payout = "PPLNS";
        fee = num(fortune?.pool_stats?.pool_fee_rate) != null
          ? Math.round(num(fortune.pool_stats.pool_fee_rate) * 10000) / 100 : 2;
        feeFromPoolAPI ||= !!fortune;
        const rate = num(fortuneFees?.pps_fee_rate);
        if (rate != null && rate >= 0 && rate <= 1) ppsFee = Math.round(rate * 10000) / 100;
      }
      const pps = /^(PPS|FPPS)/i.test(payout || "");
      const scanned = solo ? null : prlscanFor(scan, r.url);
      let perDay = scanned ??
        (r.blocks != null && r.sampleDays > 0 ? r.blocks / r.sampleDays : null);
      const reward = network?.reward;
      let theoretical = reward > 0 && network?.difficulty24h > 0
        ? reward * 86400 * 1e15 / (network.difficulty24h * WORK)
        : network?.prlPerTHDay != null ? network.prlPerTHDay * 1000 : null;
      let earnings = pps
        ? theoretical
        : hash > 0 && reward > 0 && perDay != null
          ? (perDay * reward) / (hash / 1e15)
          : null;
      let sample = scanned ?? r.blocks;
      let sampleDays = scanned != null ? 1 : r.sampleDays;
      const rolling = Array.isArray(fortune?.pool_stats?.rolling_stats) ? fortune.pool_stats.rolling_stats : [];
      const day = rolling.find((p) => num(p.hours) === 24);
      if (isFortune && fortune) {
        hash = positive(rolling.find((p) => num(p.hours) === 1)?.hashrate) || hash;
        if (positive(day?.hashrate)) {
          hash ||= positive(day.hashrate);
          if (scanned == null) {
            perDay = count(day.block_count);
            sample = perDay;
            sampleDays = 1;
          }
          earnings = num(day.total_coins) != null && num(day.total_coins) >= 0
            ? num(day.total_coins) / (num(day.hashrate) / 1e15) : null;
          theoretical = num(day.expected_coins) != null && num(day.expected_coins) >= 0
            ? num(day.expected_coins) / (num(day.hashrate) / 1e15) : null;
        }
      }
      const payouts = isFortune ? [
        payoutComparison("PPS", ppsFee, theoretical, theoretical, true, false),
        payoutComparison("PPLNS", fee, earnings, theoretical, sample == null || sample < 20, false),
      ] : [
        // Peryn's PPS+ (its default) beside its PPLNS, priced like PF's PPS.
        ...(isPeryn && !pps && perynData.ppsFee != null ? [payoutComparison("PPS+", perynData.ppsFee, theoretical, theoretical, true, false)] : []),
        payoutComparison(payout, fee, earnings, theoretical, pps || sample == null || sample < 20, solo),
      ];
      const bonus = !solo && Object.hasOwn(MERGE_BONUS, r.name) ? MERGE_BONUS[r.name] : null;
      if (bonus) for (const p of payouts) p.mergeBonus = { ...bonus };
      if (isPeryn && (foundingOpen || foundingClosed)) for (const p of payouts) if (Object.hasOwn(PERYN_FOUNDING, p.scheme)) {
        if (foundingOpen) p.founding = { ...PERYN_FOUNDING[p.scheme], closes: PERYN_FOUNDING_CLOSES };
        else p.foundingClosed = { ...PERYN_FOUNDING[p.scheme] };
      }
      const mpsRow = (Array.isArray(mps?.data) ? mps.data : []).find((p) =>
        samePool(p?.url, r.url) && ((p.url || "").toLowerCase().includes("solo") === solo));
      const recent = (Array.isArray(chain?.leaderboard?.recent_blocks) ? chain.leaderboard.recent_blocks : [])
        .filter((b) => samePool(poolURL(b, b?.miner), r.url)).map((b) => positive(b.time)).filter(Boolean);
      const lifetime = (Array.isArray(chain?.lifetime?.top) ? chain.lifetime.top : [])
        .filter((b) => samePool(poolURL(b, b?.address), r.url)).map((b) => count(b.blocks)).filter((v) => v != null);
      const lastTimes = [positive(mpsRow?.lastblocktime), ...recent, isPeryn ? perynData.lastBlockTime : null].filter(Boolean);
      return {
        id: r.url || r.name,
        name: r.name + (solo ? " SOLO" : ""),
        url: r.url,
        hashrate: hash,
        share:
          hash != null && network?.hashrate > 0
            ? hash / network.hashrate
            : null,
        miners:
          r.name === "Kryptex" && kryptex && !solo
            ? count(kryptex.miners)
            : r.miners,
        fee,
        scheme: payout,
        solo,
        pps,
        blocksPerDay: perDay,
        blocksSample: sample,
        sampleDays,
        ...(scanned != null ? { blocksSource: "prlscan" } : {}),
        earningsPerPH: earnings,
        theoreticalEarningsPerPH: theoretical,
        yieldRatio: !solo && !pps && theoretical > 0 && earnings != null ? earnings / theoretical : null,
        payouts,
        // Peryn's from its own API while miningpoolstats doesn't list it.
        history: mpsRow || !isPeryn ? decodePoolHistory(mpsRow) : perynData.history,
        averageHashrate7d: mpsRow ? (num(mpsRow.hashrate_average_7d) >= 0 ? num(mpsRow.hashrate_average_7d) : null)
          : isPeryn ? perynData.averageHashrate7d : null,
        lastBlockTime: lastTimes.length ? Math.max(...lastTimes) : null,
        lifetimeBlocks: lifetime.length ? lifetime.reduce((a, b) => a + b, 0) : isPeryn ? perynData.lifetimeBlocks : null,
        trustworthy:
          !solo &&
          !pps &&
          sample >= 20 &&
          earnings != null &&
          (rows.length === 0 || r.source === "lordofpearls"),
        source: r.source,
        hashFromPoolAPI,
        feeFromPoolAPI,
        devFee: r.name === "HeroMiners" ? 3 : null,
      };
    })
    .sort((a, b) => (b.hashrate ?? -1) - (a.hashrate ?? -1));
}

function samePool(a, b) {
  if (!safeURL(a) || !safeURL(b)) return false;
  const ah = new URL(a).hostname.toLowerCase(), bh = new URL(b).hostname.toLowerCase();
  return ah === bh || (!!pretty(a, "") && pretty(a, "") === pretty(b, ""));
}

export function payoutComparison(scheme, fee, gross, theoretical, estimated, solo) {
  return {
    scheme, fee, grossPerPH: gross, estimated, solo,
    // The server attaches settlement measurements and PPLNS estimates after reading its snapshot.
    realFeePercent: null,
  };
}

export function decodePoolHistory(pool) {
  if (!Array.isArray(pool?.history) || !positive(pool.history_start) || !positive(pool.history_interval)) return [];
  let accumulated = 0;
  const points = pool.history.slice(0, 500).map((value, i) => {
    const delta = num(value);
    if (delta != null) accumulated += delta;
    return { ts: num(pool.history_start) + i * num(pool.history_interval),
      hashrate: delta != null && Number.isFinite(accumulated) && accumulated >= 0 ? accumulated : null };
  });
  const end = points.at(-1)?.ts || 0;
  return points.filter((p) => p.ts >= end - 7 * 86400);
}
async function get(url, db, budget) {
  if (!(await reserveBudget(db, budget, 1, now()))) throw new Error("busy");
  const r = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      accept: "*/*",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (r.status !== 200) throw Object.assign(new Error("upstream"), { status: r.status });
  return readCapped(r, MAX_BODY);
}
// Every failed feed is logged with what went wrong, and a pool's own API gets one more try a second later:
// on 2026-10-21 about one snapshot in twenty lost Pearl Fortune's summary while the same six reads, run from
// seven regions for 90 minutes, never failed.
export const FEED_RETRY_MS = 1000;
async function feed(name, read, retry = false) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      const detail = e?.status != null ? `HTTP ${e.status}` : `${e?.name || "Error"}: ${e?.message || e}`;
      console.warn(`overview feed failed: ${name}, attempt ${attempt}, ${detail.slice(0, 160)}`);
      if (!retry || attempt > 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, FEED_RETRY_MS));
    }
  }
}
/// The pool data file named by the page's preload link. Found 2026-10-25: it had moved from
/// data.miningpoolstats.stream (403) to server.miningpoolstats.stream, and F2Pool and Jetski, listed
/// only there, had dropped out of the table. Only a miningpoolstats.stream host is taken.
export function mpsDataURL(page) {
  const t = page.match(/var last_time\s*=\s*"(\d+)"/)?.[1];
  if (!t) return null;
  const host = page.match(/https:\/\/([a-z0-9-]+\.miningpoolstats\.stream)\/data\/pearl\.js\?t=/i)?.[1].toLowerCase()
    || "server.miningpoolstats.stream";
  return `https://${host}/data/pearl.js?t=${t}`;
}
async function fetchMPS(db) {
  const page = await get(
    "https://miningpoolstats.stream/pearl",
    db,
    "overview-mps",
  );
  const url = mpsDataURL(page);
  if (!url) throw new Error("upstream");
  return JSON.parse(await get(url, db, "overview-mps"));
}
const LOP_PUBLIC = "https://lordofpearls.xyz/api/public";
const HERO_STATS = "https://pearl.herominers.com/api/stats";
const LUCKY_STATS = "https://pearl.luckypool.io/api/stats";
const fetchJSONFor = (db) => (url, budget) => get(url, db, budget).then(JSON.parse);
export async function overview(env, ctx, rollingCost = false) {
  try {
    // What this snapshot read that the luck bookkeeping reads too, so it isn't fetched twice.
    let prefetched = null;
    // The bookkeeping reads more block lists and doesn't hold up this reply: handed to waitUntil
    // (its windows reach readers from the next request on).
    const record = (value) => {
      const work = recordPPLNSSnapshot(env.DB, value, fetchJSONFor(env.DB), prefetched)
        .catch(() => console.warn("public PPLNS sample unavailable"));
      if (ctx?.waitUntil) ctx.waitUntil(work); else return work;
    };
    const response = await cached("pools/overview-v3", 30, ctx, () => sharedSnapshot(env.DB, async () => {
      const replies = await Promise.allSettled([
        feed("lordofpearls pools", () => get("https://lordofpearls.xyz/pools", env.DB, "overview-lop")),
        feed("lordofpearls api", () => get(LOP_PUBLIC, env.DB, "overview-lop").then(JSON.parse)),
        feed("miningpoolstats", () => fetchMPS(env.DB)),
        feed("Kryptex", () => get("https://prl-api.kryptex.network/api/v1/pool/stats", env.DB, "Kryptex").then(JSON.parse), true),
        feed("HeroMiners", () => get(HERO_STATS, env.DB, "HeroMiners").then(JSON.parse), true),
        feed("Lucky Pool", () => get(LUCKY_STATS, env.DB, "Lucky Pool").then(JSON.parse), true),
        feed("Pearl Fortune", () => get("https://pearlfortune.org/api/v1/summary", env.DB, "Pearl Fortune")
          .then(JSON.parse).then((o) => o?.data || null), true),
        // Its PPS fee is not in the summary: read once, and without it the row keeps FORTUNE_PPS_FEE
        // (logged, never a partial snapshot).
        get("https://pearlfortune.org/api/v1/stats/pool-fee-rate", env.DB, "Pearl Fortune").then(JSON.parse)
          .then((o) => o?.data || null).catch((e) => {
            console.warn(`overview feed failed: Pearl Fortune fee rate, ${e?.status != null ? `HTTP ${e.status}` : `${e?.name || "Error"}: ${e?.message || e}`}`);
            return null;
          }),
        feed("Peryn", () => get(PERYN_STATS, env.DB, "Peryn").then(JSON.parse), true),
        // Whether its Founding Miner sign-ups are open: read once; without it the founding terms are left out until
        // the closing day is over.
        get(PERYN_LAUNCH, env.DB, "Peryn").then(JSON.parse).catch((e) => {
          console.warn(`overview feed failed: Peryn launch, ${e?.status != null ? `HTTP ${e.status}` : `${e?.name || "Error"}: ${e?.message || e}`}`);
          return null;
        }),
        // prlscan's 24h block counts: read once; without them each pool keeps the table's count (logged, never a
        // partial snapshot).
        get(PRLSCAN_POOLS, env.DB, "overview-prlscan").then(JSON.parse).catch((e) => {
          console.warn(`overview feed failed: prlscan, ${e?.status != null ? `HTTP ${e.status}` : `${e?.name || "Error"}: ${e?.message || e}`}`);
          return null;
        }),
      ]);
      const [html, chain, mps, kryptex, hero, lucky, fortune, fortuneFees, peryn, perynLaunch, prlscan] = replies.map((r) =>
        r.status === "fulfilled" ? r.value : null,
      );
      prefetched = { [LOP_PUBLIC]: chain, [HERO_STATS]: hero, [LUCKY_STATS]: lucky };
      const network = parseNetwork(chain) || mpsNetwork(mps, kryptex);
      const table = parseTable(html || "");
      const rows = buildOverview(table.length ? table : chainPoolRows(chain), network, {
        mps,
        kryptex,
        hero,
        lucky,
        chain,
        fortune,
        fortuneFees,
        peryn,
        perynLaunch,
        prlscan,
      });
      if (!rows.length && !network) throw new Error("upstream");
      return {
        ok: true,
        schemaVersion: 1,
        ts: now(),
        source: rows.some((r) => r.source === "lordofpearls")
          ? "lordofpearls"
          : "miningpoolstats",
        network,
        rows,
        partial:
          replies.some((r) => r.status === "rejected") ||
          !network ||
          !rows.length,
        stale: !!network && now() - network.ts > 900,
      };
    }, record));
    if (!response.ok) return response;
    const snapshot = await response.json();
    let measurements = [], luck = { pplns: [], luck: new Map() };
    try { measurements = await readRealFees(env.DB); } catch {}
    try { luck = await readPoolLuck(env.DB); } catch {}
    return json(attachLuck(attachRealFees(snapshot, measurements, luck.pplns, rollingCost), luck.luck));
  } catch {
    return json({ ok: false, error: "upstream" }, 502);
  }
}

// D1 holds one public snapshot across edge regions, Web sessions and app installs.
// The atomic lease prevents different regions from polling the same nine feeds
// at once. Neither cache key includes an address, account or installation ID.
const SNAPSHOT_KEY = "public:overview:v1";
const LEASE_KEY = "public:overview:lease:v1";
const FRESH_SECONDS = 300;
const FALLBACK_SECONDS = 1800;
const LEASE_SECONDS = 30;
/// `record(value)` runs after a new snapshot is stored (the luck bookkeeping); it may hand its
/// work to waitUntil and return at once.
export async function sharedSnapshot(db, build, record = (value) => recordPPLNSSnapshot(db, value, fetchJSONFor(db))) {
  const read = async () => {
    const stored = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(SNAPSHOT_KEY).first();
    try {
      const value = JSON.parse(stored?.v || "null");
      return value?.ok === true && value.schemaVersion === 1 && Number.isFinite(value.ts) &&
        value.ts > 0 && value.ts <= now() + 60 && Array.isArray(value.rows) &&
        (value.rows.length || value.network) ? value : null;
    } catch { return null; }
  };
  const reply = (value, degraded = false) => ({ ...value,
    stale: degraded || !!value.stale || (!!value.network?.ts && now() - value.network.ts > 900),
    partial: degraded || !!value.partial,
  });
  const previous = await read();
  if (previous && now() - previous.ts < FRESH_SECONDS) return reply(previous);
  const token = crypto.randomUUID();
  const lease = await db.prepare(`INSERT INTO kv (k, v, ts) VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts WHERE kv.ts <= ?`)
    .bind(LEASE_KEY, token, now(), now() - LEASE_SECONDS).run();
  if (!lease.meta.changes) {
    if (previous && now() - previous.ts <= FALLBACK_SECONDS) return json(reply(previous, true));
    // Cold deployment: briefly allow the current owner to finish instead of polling
    // the upstream feeds a second time. A retry remains possible if it is slower.
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const value = await read();
      if (value && now() - value.ts < FRESH_SECONDS) return reply(value);
    }
    throw new Error("busy");
  }
  try {
    // Another owner may have completed between our first read and lease acquisition.
    const current = await read();
    if (current && now() - current.ts < FRESH_SECONDS) return reply(current);
    const value = await build();
    if (!value?.ok || !Array.isArray(value.rows) || (!value.rows.length && !value.network)) throw new Error("upstream");
    if (previous?.rows.length && !value.rows.length) throw new Error("upstream");
    await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, ?, ?)")
      .bind(SNAPSHOT_KEY, JSON.stringify(value), value.ts).run();
    // The pools' own block lists (each block's effort) take luck out of the cost estimate.
    try { await record(value); }
    catch { console.warn("public PPLNS sample unavailable"); }
    return value;
  } catch (error) {
    if (previous && now() - previous.ts <= FALLBACK_SECONDS) return json(reply(previous, true));
    throw error;
  } finally {
    await db.prepare("DELETE FROM kv WHERE k = ? AND v = ?").bind(LEASE_KEY, token).run();
  }
}
