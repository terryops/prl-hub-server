// Apple Push Notification service over HTTP/2 with token (JWT) auth.
//
// Workers' fetch() speaks HTTP/2 to api.push.apple.com, so no client library is
// needed: sign an ES256 JWT with the .p8 key (WebCrypto yields the raw r||s
// signature JWS wants) and POST the payload.
//
// Apple rejects provider tokens refreshed more than once per 20 min and expires
// them after 60, so one token is minted per ~50 min and shared by all isolates
// through the `kv` table. Within an isolate the mint is single-flight: a tick's
// concurrent pushes all wait on the one token instead of each signing its own.

const HOSTS = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
const JWT_TTL = 50 * 60;
/// One APNs request never holds a tick longer than this.
const TIMEOUT_MS = 10_000;
/// How long a device waits after APNs answers 429 (too many pushes to it).
export const BACKOFF_429 = 5 * 60;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJSON = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function importP8(pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function signJWT({ keyPem, keyId, teamId, iat }) {
  const head = b64urlJSON({ alg: "ES256", kid: keyId });
  const claims = b64urlJSON({ iss: teamId, iat });
  const key = await importP8(keyPem);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

let memo = null;     // { jwt, iat } — per-isolate cache in front of the D1 copy
let minting = null;  // the in-flight mint every concurrent caller awaits

/// The current provider token. `stale` is one APNs just rejected: any other
/// token is reused, so a burst of 403s refreshes it once, not once per push.
async function providerToken(env, db, stale = null) {
  for (let round = 0; round < 2; round++) {
    const now = Math.floor(Date.now() / 1000);
    if (memo && memo.jwt !== stale && now - memo.iat < JWT_TTL) return memo.jwt;
    if (!minting) {
      const p = mint(env, db, stale).finally(() => { if (minting === p) minting = null; });
      minting = p;
    }
    memo = await minting;
    if (memo.jwt !== stale) return memo.jwt;
    // Joined a mint that began before this token failed, and it handed that token back.
  }
  return memo.jwt;
}

async function mint(env, db, stale) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'apns_jwt'").first().catch(() => null);
  if (row && row.v !== stale && now - row.ts < JWT_TTL) return { jwt: row.v, iat: row.ts };
  const jwt = await signJWT({ keyPem: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, iat: now });
  // Sharing it with other isolates is an optimization: a failed write must not fail the pushes.
  try { await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('apns_jwt', ?, ?)").bind(jwt, now).run(); }
  catch (e) { console.error("apns_jwt save", String(e && e.message ? e.message : e)); }
  return { jwt, iat: now };
}

/// Tests: forget the cached token.
export function resetTokenCache() {
  memo = null;
  minting = null;
}

export const apnsConfigured = (env) => !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);

async function post(envName, device, payload, jwt, opts) {
  try {
    return await postOnce(envName, device, payload, jwt, opts);
  } catch (e) {
    // Network failure or timeout (not an APNs verdict): treat as transient.
    return { status: 0, reason: String(e && e.message ? e.message : e) };
  }
}

async function postOnce(envName, device, payload, jwt, opts) {
  const r = await fetch(`https://${HOSTS[envName]}/3/device/${device.token}`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `bearer ${jwt}`,
      // Live Activity updates go to "<bundle>.push-type.liveactivity".
      "apns-topic": opts.pushType === "liveactivity" ? `${device.topic}.push-type.liveactivity` : device.topic,
      "apns-push-type": opts.pushType || "alert",
      "apns-priority": String(opts.priority || 10),
      // A price alert is worthless hours later — let APNs drop it after 1 h
      // (callers can shorten it: a live price is stale within minutes).
      "apns-expiration": String(Math.floor(Date.now() / 1000) + (opts.ttl || 3600)),
      ...(opts.collapseId ? { "apns-collapse-id": opts.collapseId.slice(0, 64) } : {}),
    },
    body: JSON.stringify(payload),
  });
  let reason = null;
  if (r.status !== 200) {
    try { reason = (await r.json()).reason; } catch { /* empty body */ }
  }
  return { status: r.status, reason };
}

/// Send one notification. Returns
///   { ok: true, env }          delivered (env = the APNs environment that took it)
///   { ok: false, drop: true }  token is dead — caller should forget the device
///   { ok: false, retry: true } transient (network, timeout, 5xx, 429) — try again on a
///                              later tick; `backoff` (s), if set, holds the device that long
///   { ok: false, fail: true }  APNs refused this push for good (BadTopic,
///                              PayloadTooLarge, …) — repeating it can't help
export async function send(env, db, device, payload, opts = {}) {
  let jwt = await providerToken(env, db);
  let res = await post(device.env, device, payload, jwt, opts);

  if (res.status === 403 && (res.reason === "ExpiredProviderToken" || res.reason === "InvalidProviderToken")) {
    jwt = await providerToken(env, db, jwt);
    res = await post(device.env, device, payload, jwt, opts);
  }
  if (res.status === 200) return { ok: true, env: device.env };

  // The app only guesses its APNs environment (Debug → sandbox). A token from
  // the other environment answers BadDeviceToken, so try the other host once.
  if (res.status === 400 && res.reason === "BadDeviceToken") {
    const other = device.env === "production" ? "sandbox" : "production";
    const res2 = await post(other, device, payload, jwt, opts);
    if (res2.status === 200) return { ok: true, env: other };
    if (res2.status === 400 && res2.reason === "BadDeviceToken") return { ok: false, drop: true, reason: res2.reason };
    return verdict(res2);
  }
  if (res.status === 410 || (res.status === 400 && res.reason === "DeviceTokenNotForTopic")) {
    return { ok: false, drop: true, reason: res.reason };
  }
  return verdict(res);
}

function verdict({ status, reason }) {
  if (status === 429) return { ok: false, retry: true, backoff: BACKOFF_429, status, reason };
  if (status === 0 || status >= 500) return { ok: false, retry: true, status, reason };
  return { ok: false, fail: true, status, reason };
}
