// Firebase Cloud Messaging (HTTP v1) for the Android app, using only Workers WebCrypto.
//
// FCM_SERVICE_ACCOUNT is a Google service-account key (the JSON file as a secret).
// Its RSA key signs an RS256 JWT that oauth2.googleapis.com trades for an access
// token (the JWT-bearer grant). The token is kept in this isolate's memory until a
// minute before Google says it expires; within an isolate the mint is single-flight,
// so a tick's concurrent pushes all wait on one token.
//
// Messages are data-only: the app builds the notification itself from
// { title, body, kind, tag, route }.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/// One request never holds a tick longer than this.
const TIMEOUT_MS = 8000;
/// A cached access token is replaced this long before it expires.
const EARLY = 60;
const ROUTES = { price: "market", offline: "workers", test: "alerts" };

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJSON = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let parsed = null; // { raw, sa } — the secret, parsed once per isolate

/// The service account, or null when the secret is missing or not one.
function serviceAccount(env) {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (typeof raw !== "string") return null;
  if (parsed?.raw !== raw) {
    let sa = null;
    try { sa = JSON.parse(raw); } catch { /* not JSON */ }
    const ok = sa && ["project_id", "client_email", "private_key"].every((k) => typeof sa[k] === "string" && sa[k]);
    parsed = { raw, sa: ok ? sa : null };
  }
  return parsed.sa;
}

export const fcmConfigured = (env) => !!serviceAccount(env);

async function importKey(pem) {
  // A key pasted with its newlines still escaped (\n) imports too.
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\\n|\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJWT(sa, iat) {
  const head = b64urlJSON({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) });
  const claims = b64urlJSON({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
  const key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

let memo = null;     // { raw, token, exp } — the current access token
let minting = null;  // { raw, p } — the in-flight mint every concurrent caller awaits

/// → { token } | { error: a send() result }. `stale` is a token FCM just refused:
/// it is not handed out again.
async function accessToken(env, sa, stale = null) {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (memo && memo.raw === raw && memo.token !== stale && Date.now() / 1000 < memo.exp - EARLY) return { token: memo.token };
  if (!minting || minting.raw !== raw) {
    const p = mint(sa).finally(() => { if (minting?.p === p) minting = null; });
    minting = { raw, p };
  }
  const got = await minting.p;
  if (got.token) memo = { raw, token: got.token, exp: got.exp };
  return got;
}

async function mint(sa) {
  const iat = Math.floor(Date.now() / 1000);
  let jwt;
  try { jwt = await signJWT(sa, iat); }
  catch { return { error: { ok: false, fail: true, reason: "invalid FCM configuration" } }; }
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
    });
    const out = r.status === 200 ? await r.json().catch(() => null) : null;
    if (typeof out?.access_token === "string" && out.access_token) {
      return { token: out.access_token, exp: iat + (Number(out.expires_in) || 3600) };
    }
    // Google is down or busy: the push goes again on a later tick. Anything else
    // (a revoked key, a disabled account) won't mend by retrying.
    if (r.status === 429 || r.status >= 500) return { error: { ok: false, retry: true, status: r.status, reason: "fcm auth unavailable" } };
    return { error: { ok: false, fail: true, status: r.status, reason: "fcm auth refused" } };
  } catch {
    return { error: { ok: false, retry: true, reason: "fcm auth failed" } };
  }
}

/// Tests: forget the cached token.
export function resetTokenCache() {
  memo = null;
  minting = null;
}

/// The data message for an APNs payload (i18n.js / the offline pushes in index.js).
/// kind: price (a rule, also when queued for quiet hours), offline (a monitor's
/// workers went down or came back), test. tag: what the notification replaces —
/// the rule id, as APNs collapses on, or the watch, as Web Push tags it.
export function dataFor(payload, opts = {}) {
  const alert = payload.aps?.alert || {};
  const kind = payload.watch ? "offline" : payload.alert && !payload.alert.test ? "price" : "test";
  const tag = kind === "offline" ? `worker:${payload.watch.id}` : kind === "price" ? String(opts.collapseId || payload.alert.id || "price-alert") : "test";
  return {
    title: String(alert.title || "Pearl Hub"),
    // Android shows the monitor's name (the APNs subtitle) as the body's first line.
    body: [alert.subtitle, alert.body].filter(Boolean).join("\n"),
    kind,
    tag,
    route: ROUTES[kind],
  };
}

async function post(sa, token, message) {
  try {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (r.status === 200) return { status: 200 };
    let error = null;
    try { error = (await r.json()).error; } catch { /* empty body */ }
    return { status: r.status, error, retryAfter: r.headers.get("retry-after") };
  } catch {
    // Network failure or timeout (not an FCM verdict): treat as transient.
    return { status: 0 };
  }
}

/// Send one notification to the registration token `reg`. Returns what apns.js
/// send() returns:
///   { ok: true, env }          delivered
///   { ok: false, drop: true }  the token is dead — caller should forget the device
///   { ok: false, retry: true } transient (network, 429, 5xx) — try again on a later
///                              tick; `backoff` (s), if set, holds the device that long
///   { ok: false, fail: true }  refused for good (bad payload, auth / config problem)
export async function send(env, reg, payload, opts = {}) {
  return sendData(env, reg, dataFor(payload, opts), opts);
}

/// 锁屏盯盘 (the Android app's Live Activity): the price state the iOS activity gets as its
/// content-state, as a data message the app turns into its ongoing notification. Values are
/// strings (FCM data); an unknown change is left out. Collapsed on "live", so a phone that was
/// offline gets only the newest price.
export function liveData(state) {
  const data = { kind: "live", tag: "live", usd: String(state.usd), at: String(state.at) };
  for (const k of ["change1h", "change24h"]) if (Number.isFinite(state[k])) data[k] = String(state[k]);
  return data;
}

/// Send one data message (all values strings) to the registration token `reg`.
export async function sendData(env, reg, data, opts = {}) {
  const sa = serviceAccount(env);
  if (!sa) return { ok: false, fail: true, reason: "fcm not configured" };
  const message = {
    token: reg,
    data,
    android: {
      priority: opts.priority && opts.priority < 10 ? "NORMAL" : "HIGH",
      ttl: `${Math.max(0, Math.floor(opts.ttl ?? 3600))}s`,
      ...(data.tag ? { collapse_key: data.tag } : {}),
    },
  };
  let auth = await accessToken(env, sa);
  if (auth.error) return auth.error;
  let res = await post(sa, auth.token, message);
  // A token Google revoked before its time: mint another once.
  if (res.status === 401) {
    auth = await accessToken(env, sa, auth.token);
    if (auth.error) return auth.error;
    res = await post(sa, auth.token, message);
  }
  return verdict(res);
}

const errorCode = (e) =>
  e?.details?.find((d) => typeof d?.errorCode === "string")?.errorCode || (typeof e?.status === "string" ? e.status : null);
// INVALID_ARGUMENT also covers a malformed message; only one about the token drops it.
const aboutToken = (e) =>
  !!e?.details?.some((d) => d?.fieldViolations?.some((v) => v?.field === "message.token")) ||
  /registration token/i.test(String(e?.message || ""));

function verdict({ status, error, retryAfter }) {
  if (status === 200) return { ok: true, env: "production" };
  if (status === 0) return { ok: false, retry: true, reason: "fcm request failed" };
  const code = errorCode(error);
  if (status === 404 || code === "UNREGISTERED") return { ok: false, drop: true, status, reason: code || "unregistered" };
  if (status === 400 && code === "INVALID_ARGUMENT" && aboutToken(error)) return { ok: false, drop: true, status, reason: "invalid registration token" };
  if (status === 429) {
    return { ok: false, retry: true, status, backoff: Math.min(3600, Math.max(60, Number(retryAfter) || 60)), reason: code || "quota exceeded" };
  }
  if (status >= 500) return { ok: false, retry: true, status, reason: code || "fcm unavailable" };
  // 401 / 403: the service account or project is wrong (SENDER_ID_MISMATCH included —
  // with a misconfigured project every token would say so, and none may be dropped).
  return { ok: false, fail: true, status, reason: code || "fcm refused" };
}
