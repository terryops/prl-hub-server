// Test harness: an in-memory D1 (node:sqlite), a fetch mock for the price
// sources and APNs, a settable clock, and a throwaway X.509 chain to sign
// Apple-style JWS with.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { resetTokenCache } from "../src/apns.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// Cloudflare's extension to WebCrypto.
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => Buffer.from(a).equals(Buffer.from(b));
}

// ── D1 ───────────────────────────────────────────────────────────────────────

/// schema.sql + migrations/, behind D1's API. `hooks.before(sql, params)` runs
/// before every statement (throw to fail it, await to stall it);
/// `hooks.beforeBatch(stmts)` before every batch.
export function makeD1(hooks = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(`${root}/schema.sql`, "utf8"));
  for (const f of readdirSync(`${root}/migrations`).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(`${root}/migrations/${f}`, "utf8"));
  }
  const log = [];
  const val = (v) => (v === true ? 1 : v === false ? 0 : v);
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...p) { return new Stmt(this.sql, p.map(val)); }
    async hook() {
      log.push(this.sql.replace(/\s+/g, " ").trim());
      if (hooks.before) await hooks.before(this.sql, this.params);
    }
    async first() { await this.hook(); const r = raw.prepare(this.sql).get(...this.params); return r ? { ...r } : null; }
    async all() { await this.hook(); return { results: raw.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true }; }
    async run() { await this.hook(); return result(raw.prepare(this.sql).run(...this.params)); }
    runSync() { return result(raw.prepare(this.sql).run(...this.params)); }
  }
  const result = (r) => ({ success: true, meta: { changes: Number(r.changes) } });
  return {
    raw,
    log,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      log.push(`BATCH(${stmts.length})`);
      if (hooks.beforeBatch) await hooks.beforeBatch(stmts);
      for (const s of stmts) if (hooks.before) await hooks.before(s.sql, s.params);
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    rows: (sql, ...p) => raw.prepare(sql).all(...p).map((r) => ({ ...r })),
    one: (sql, ...p) => { const r = raw.prepare(sql).get(...p); return r ? { ...r } : null; },
  };
}

// ── clock ────────────────────────────────────────────────────────────────────

const realNow = Date.now;
/// Freeze Date.now at unix second `t`.
export function setNow(t) { Date.now = () => t * 1000; }
export function restoreNow() { Date.now = realNow; }

// 2026-09-23 00:00:00 UTC — an hour boundary (prune runs), 08:00 in Shanghai.
export const T0 = Date.UTC(2026, 8, 23) / 1000;

// ── fetch ────────────────────────────────────────────────────────────────────

/// Mocks every outbound request. Price sources all quote `state.price`; APNs
/// answers via `state.apns(call)` → { status, reason } (default 200) and every
/// call is recorded in `state.calls`. Pool requests (掉线提醒) go to
/// `state.pool(url, init)` → a Response, and are recorded in `state.polls`.
export function installFetch() {
  const state = { price: 0.8, calls: [], apns: () => ({ status: 200 }), pool: null, polls: [], overview: null, overviewRequests: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname.endsWith("push.apple.com")) {
      const call = {
        host: u.hostname,
        token: u.pathname.split("/").pop(),
        headers: init.headers,
        body: JSON.parse(init.body),
        signal: init.signal,
      };
      state.calls.push(call);
      const r = await state.apns(call);
      return new Response(r.status === 200 ? null : JSON.stringify({ reason: r.reason }), { status: r.status });
    }
    if (["lordofpearls.xyz", "miningpoolstats.stream", "data.miningpoolstats.stream"].includes(u.hostname) ||
        u.hostname === "prl-api.kryptex.network" && u.pathname === "/api/v1/pool/stats" ||
        u.hostname === "pearl.herominers.com" && u.pathname === "/api/stats" ||
        u.hostname === "pearlfortune.org" && u.pathname === "/api/v1/summary") {
      state.overviewRequests.push({ url: String(url), headers: init.headers });
      return state.overview ? state.overview(u, init) : new Response("overview unavailable", { status: 503 });
    }
    if (state.pool && POOL_HOSTS.includes(u.hostname)) {
      state.polls.push({ url: String(url), headers: init.headers });
      return state.pool(u, init);
    }
    const J = (o) => Response.json(o);
    const p = String(state.price);
    if (u.hostname === "api.coinex.com") return J({ code: 0, data: [{ last: p, open: "0.78" }] });
    if (u.hostname === "big.one") return J({ code: 0, data: { close: p, open: "0.78" } });
    if (u.hostname === "whattomine.com") return J({ exchange_rate: state.price / 80000, timestamp: Date.now() / 1000 });
    if (u.hostname === "api.kraken.com") return J({ result: { XXBTZUSD: { c: ["80000"] } } });
    if (u.hostname === "api.coinbase.com") return J({ data: { amount: "80000" } });
    return new Response("nope", { status: 404 });
  };
  state.alerts = () => state.calls.filter((c) => (c.headers["apns-push-type"] || "alert") === "alert");
  return state;
}

const POOL_HOSTS = ["pearl.alphapool.tech", "pearl.luckypool.io", "pearl.herominers.com", "pearlfortune.org",
                    "pearlhash.xyz", "prl-api.kryptex.network", "www.f2pool.com", "pearl.jetskipool.ai"];

// ── worker ───────────────────────────────────────────────────────────────────

export async function p8() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
}

const KEY = await p8();

/// A fresh worker environment (own database, APNs configured, no rate limits).
export function makeEnv(extra = {}, hooks = {}) {
  resetTokenCache();
  return {
    DB: makeD1(hooks),
    APNS_KEY: KEY,
    APNS_KEY_ID: "KEY0000000",
    APNS_TEAM_ID: "TEAM000000",
    APNS_TOPICS: "com.prl.wizard",
    ASN_SECRET: "asn-secret",
    INGEST_TOKEN: "ingest-token",
    ...extra,
  };
}

export const tok = (i) => i.toString(16).padStart(64, "a");
export const liveTok = (i) => i.toString(16).padStart(160, "b");

export async function call(env, method, path, body, headers = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await worker.fetch(new Request(`https://prl.test${path}`, init), env, {});
  const out = { status: res.status, body: await res.json() };
  // Non-enumerable, so the many deepEqual({status, body}) checks are unaffected.
  Object.defineProperty(out, "headers", { value: res.headers });
  return out;
}

export const register = (env, token, rules, extra = {}) =>
  call(env, "PUT", `/v1/devices/${token}`, { env: "production", topic: "com.prl.wizard", oneshot: true, rules, ...extra });

export const tick = (env) => worker.scheduled({}, env);

/// Register a device as a 1.20+ app does: its 掉线提醒 watches, and (`extra.rules`) its
/// price alerts — none unless given, since that app always sends both lists.
export const watch = (env, token, watches, extra = {}) =>
  call(env, "PUT", `/v1/devices/${token}`, { env: "production", topic: "com.prl.wizard", oneshot: true, rules: [], watches, ...extra });

// ── X.509 / JWS ──────────────────────────────────────────────────────────────

const cat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of a) { out.set(x, p); p += x.length; }
  return out;
};
function der(tag, ...parts) {
  const body = cat(...parts);
  const n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return cat(Uint8Array.of(tag, ...len), body);
}
const seq = (...p) => der(0x30, ...p);
function oid(s) {
  const a = s.split(".").map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const b = [v & 0x7f];
    for (let x = Math.floor(v / 128); x; x = Math.floor(x / 128)) b.unshift((x & 0x7f) | 0x80);
    out.push(...b);
  }
  return der(0x06, Uint8Array.from(out));
}
const int = (n) => der(0x02, Uint8Array.of(n));
const name = (cn) => seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, new TextEncoder().encode(cn)))));
function utc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return der(0x17, new TextEncoder().encode(s));
}
function sigDER(raw) {
  const half = raw.length / 2;
  const intOf = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    return der(0x02, b[0] & 0x80 ? cat(Uint8Array.of(0), b) : b);
  };
  return seq(intOf(raw.subarray(0, half)), intOf(raw.subarray(half)));
}

const SIG_OID = { "SHA-256": "1.2.840.10045.4.3.2", "SHA-384": "1.2.840.10045.4.3.3" };
export const LEAF_OID = "1.2.840.113635.100.6.11.1";
export const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

async function cert({ subject, issuer, pub, signer, hash = "SHA-384", exts = [], notBefore, notAfter, serial }) {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pub));
  const alg = seq(oid(SIG_OID[hash]));
  const extensions = exts.length
    ? [der(0xa3, seq(...exts.map((o) => seq(oid(o), der(0x04, Uint8Array.of(0x05, 0x00))))))]
    : [];
  const tbs = seq(der(0xa0, int(2)), int(serial), alg, name(issuer), seq(utc(notBefore), utc(notAfter)),
                  name(subject), spki, ...extensions);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, signer, tbs));
  return seq(tbs, alg, der(0x03, Uint8Array.of(0), sigDER(raw)));
}

const ec = (namedCurve) => crypto.subtle.generateKey({ name: "ECDSA", namedCurve }, true, ["sign", "verify"]);

/// Root (P-384) → intermediate (P-384) → leaf (P-256), shaped like Apple's.
/// Options drop a marker extension or move the leaf's validity window.
export async function makeChain({ midExts = [INTERMEDIATE_OID], leafExts = [LEAF_OID], leafNotAfter } = {}) {
  const [rk, mk, lk] = await Promise.all([ec("P-384"), ec("P-384"), ec("P-256")]);
  const from = Date.UTC(2020, 0, 1), to = Date.UTC(2040, 0, 1);
  const rootDER = await cert({ subject: "Test Root", issuer: "Test Root", pub: rk.publicKey, signer: rk.privateKey,
                               notBefore: from, notAfter: to, serial: 1 });
  const midDER = await cert({ subject: "Test WWDR", issuer: "Test Root", pub: mk.publicKey, signer: rk.privateKey,
                              exts: midExts, notBefore: from, notAfter: to, serial: 2 });
  const leafDER = await cert({ subject: "Test Leaf", issuer: "Test WWDR", pub: lk.publicKey, signer: mk.privateKey,
                               exts: leafExts, notBefore: from, notAfter: leafNotAfter ?? to, serial: 3 });
  const rootSHA256 = Buffer.from(await crypto.subtle.digest("SHA-256", rootDER)).toString("hex");
  return { x5c: [leafDER, midDER, rootDER].map((d) => Buffer.from(d).toString("base64")), leafKey: lk.privateKey, rootSHA256 };
}

const b64u = (x) => Buffer.from(x).toString("base64url");

/// A compact JWS over `payload`, signed by the chain's leaf.
export async function signJWS(chain, payload, { x5c = chain.x5c, alg = "ES256" } = {}) {
  const head = b64u(JSON.stringify({ alg, x5c }));
  const body = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chain.leafKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
}

/// A StoreKit 2 transaction for Pro, as the app would send in pro_jws.
export const proTx = (extra = {}) => ({
  bundleId: "com.prl.wizard", productId: "com.prl.wizard.pro", transactionId: "2000001",
  originalTransactionId: "1000001", environment: "Production", signedDate: Date.UTC(2026, 8, 1), ...extra,
});
