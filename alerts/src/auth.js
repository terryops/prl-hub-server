import { now, hex, sha256, webJson as json } from "./http.js";

import { revokeDevice } from "./account-lifecycle.js";
import { verificationEmail } from "./account-email.js";

const ID = /^[A-Za-z0-9_-]{16,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();
export const COOKIE = "__Host-prl_session";
const IDLE = 30 * 86400, MAX = 90 * 86400, ACCESS = 900;
export const random = (n = 32) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export const enabled = (env) => env.ACCOUNT_ENABLED === "1" && !!env.AUTH_PEPPER && !!env.ACCOUNT_CONFIG_KEY &&
  !!env.TURNSTILE_SECRET && !!env.TURNSTILE_SITE_KEY && !!env.EMAIL_FROM && !!env.EMAIL?.send;
const error = (code, status = 400) => json({ error: code }, status);

export function emailOf(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ? email : null;
}
export async function digest(env, value) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.AUTH_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function originOK(req, env) {
  const origin = req.headers.get("origin");
  if (!origin || origin === (env.ACCOUNT_ORIGIN || new URL(req.url).origin)) return true;
  const path = new URL(req.url).pathname;
  return ["/v1/auth/exchange", "/v1/auth/refresh"].includes(path) && (env.ACCOUNT_REDIRECTS || "").split(",").some((uri) => {
    const id = uri.trim().match(/^https:\/\/([a-p]{32})\.chromiumapp\.org\/account$/)?.[1];
    return id && origin === `chrome-extension://${id}`;
  });
}
export async function authenticate(req, env, checkExpected = true) {
  const bearer = req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const cookie = req.headers.get("cookie")?.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const token = bearer || cookie;
  if (!token || !TOKEN.test(token)) return null;
  if (!bearer && !["GET", "HEAD"].includes(req.method) &&
      req.headers.get("origin") !== (env.ACCOUNT_ORIGIN || new URL(req.url).origin)) return null;
  const t = now();
  const session = await env.DB.prepare(`SELECT s.*, u.email, d.name, d.platform FROM sessions s
    JOIN users u ON u.id = s.user_id JOIN account_devices d ON d.user_id = s.user_id AND d.id = s.device_id
    WHERE s.access_hash = ? AND s.revoked_at IS NULL AND u.deleted_at IS NULL AND d.revoked_at IS NULL
    AND s.idle_expires > ? AND s.max_expires > ? AND (s.client = 'web' OR s.access_expires > ?)`)
    .bind(await sha256(token), t, t, t).first();
  if (!session || (!!bearer !== (session.client !== "web"))) return null;
  const expected = req.headers.get("x-account-id");
  if (checkExpected && expected && expected !== session.user_id) return null;
  if (session.client !== "web" && session.generation_used_at == null) {
    const used = await env.DB.prepare(`UPDATE sessions SET generation_used_at=?
      WHERE id=? AND access_hash=? AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM account_devices WHERE user_id=? AND id=? AND revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL) RETURNING id`)
      .bind(t, session.id, session.access_hash, session.user_id, session.device_id, session.user_id).first();
    if (!used) return null;
    session.generation_used_at = t;
  }
  if (session.seen_at < t - 3600) {
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET seen_at = ?, idle_expires = MIN(max_expires, ?) WHERE id = ? AND revoked_at IS NULL").bind(t, t + IDLE, session.id),
      env.DB.prepare("UPDATE account_devices SET seen_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL").bind(t, session.user_id, session.device_id),
    ]);
  }
  return session;
}
export async function readBody(req, cap = 8192) {
  if (Number(req.headers.get("content-length")) > cap) throw new Error("body_limit");
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel(); throw new Error("body_limit"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad_body");
  return data;
}
async function budget(db, key, expires, limit) {
  return !!await db.prepare(`INSERT INTO auth_budgets(key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = auth_budgets.count + 1 WHERE auth_budgets.count < ? RETURNING key`)
    .bind(key, expires, limit).first();
}
async function human(req, env, body, purpose) {
  if (typeof body.turnstile !== "string" || body.turnstile.length > 2048) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: body.turnstile,
      remoteip: req.headers.get("cf-connecting-ip") || undefined }),
  });
  const result = await res.json();
  return res.ok && result.success === true && result.hostname === new URL(env.ACCOUNT_ORIGIN || req.url).hostname && result.action === `email_${purpose}`;
}
export async function startEmail(req, env, body) {
  if (!enabled(env)) return error("accounts_unavailable", 503);
  if (!originOK(req, env)) return error("bad_origin", 403);
  const email = emailOf(body.email), purpose = body.purpose || "login";
  if (!email || !["login", "delete", "change_old", "change_new", "purchase"].includes(purpose)) return error("bad_email");
  const session = purpose === "login" ? null : await authenticate(req, env);
  if (purpose !== "login" && (!session || (purpose !== "change_new" && session.email !== email))) return error("unauthorized", 401);
  const t = now(), db = env.DB, ip = req.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await digest(env, `ip:${ip}`);
  if (!await budget(db, `ip:${ipHash}:${Math.floor(t / 900)}`, t + 900, 30)) return error("rate_limited", 429);
  try { if (!await human(req, env, body, purpose)) return error("human_verification_failed", 403); }
  catch { return error("human_verification_unavailable", 503); }
  const emailHash = await digest(env, `email:${email}`);
  const sendBudgets = [
    [`cooldown:${emailHash}:${Math.floor(t / 60)}`, t + 60, 1],
    [`hour:${emailHash}:${Math.floor(t / 3600)}`, t + 3600, 6],
    [`day:${emailHash}:${Math.floor(t / 86400)}`, t + 86400, 20],
    [`global:${Math.floor(t / 86400)}`, t + 86400, Math.min(10000, Math.max(1, Number(env.EMAIL_DAILY_LIMIT) || 100))],
  ];
  // A conditional challenge INSERT enforces the rolling cooldown, not just a fixed bucket.
  for (const [key, expires, limit] of sendBudgets) if (!await budget(db, key, expires, limit)) return error("rate_limited", 429);
  const id = random(24);
  const bytes = new Uint32Array(1), ceiling = Math.floor(2 ** 32 / 1000000) * 1000000;
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
  const code = String(bytes[0] % 1000000).padStart(6, "0");
  const inserted = await db.prepare(`INSERT INTO auth_challenges(id, email, purpose, user_id, code_hash, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM auth_challenges WHERE email = ? AND created_at > ?)
    RETURNING id`).bind(id, email, purpose, session?.user_id || null, await digest(env, `${id}:${email}:${purpose}:${code}`), t, t + 300, email, t - 60).first();
  if (!inserted) return error("rate_limited", 429);
  await db.prepare("UPDATE auth_challenges SET consumed_at = ? WHERE email = ? AND purpose = ? AND id <> ? AND consumed_at IS NULL").bind(t, email, purpose, id).run();
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: "Pearl Hub" }, to: email,
      ...verificationEmail({ code, purpose, lang: body.lang }) });
    await db.prepare("UPDATE auth_challenges SET delivered = 1 WHERE id = ?").bind(id).run();
  } catch {
    await db.prepare("UPDATE auth_challenges SET consumed_at = ? WHERE id = ?").bind(t, id).run();
    console.warn("account email send failed"); return error("email_unavailable", 503);
  }
  return json({ challenge_id: id, expires_in: 300, resend_after: 60 });
}
export async function consumeChallenge(env, body, purpose, user = null) {
  if (!ID.test(body.challenge_id || "") || !/^\d{6}$/.test(body.code || "")) return null;
  const db = env.DB, t = now();
  const row = await db.prepare(`UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ? AND purpose = ?
    AND consumed_at IS NULL AND delivered = 1 AND expires_at > ? AND attempts < 5
    AND (user_id IS NULL OR user_id = ?) RETURNING *`).bind(body.challenge_id, purpose, t, user).first();
  if (!row || !equal(row.code_hash, await digest(env, `${row.id}:${row.email}:${row.purpose}:${body.code}`))) return null;
  return await db.prepare(`UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
    AND expires_at > ? RETURNING email, user_id`).bind(t, row.id, t).first();
}
export async function makeSession(env, userId, body, client = "web", verifiedAt = now()) {
  const t = now(), db = env.DB;
  const deviceId = ID.test(body.device_id || "") ? body.device_id : random(24);
  const platform = ["web", "extension", "ios", "macos", "android"].includes(body.platform) ? body.platform : "web";
  const name = typeof body.device_name === "string" && body.device_name.trim() ? body.device_name.trim().slice(0, 80) : platform;
  const access = random(), refresh = client === "web" ? null : random(), sid = random(24);
  const slot = await db.prepare(`INSERT INTO account_devices(id, user_id, name, platform, created_at, seen_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
    AND ((SELECT COUNT(*) FROM account_devices WHERE user_id=? AND revoked_at IS NULL)<20
      OR EXISTS(SELECT 1 FROM account_devices WHERE user_id=? AND id=? AND revoked_at IS NULL))
    ON CONFLICT(user_id, id) DO UPDATE SET revoked_at=NULL, seen_at=excluded.seen_at, name=excluded.name, platform=excluded.platform
    RETURNING id`).bind(deviceId,userId,name,platform,t,t,userId,userId,userId,deviceId).first();
  if (!slot) return null;
  await db.batch([
    // A new login on this installation replaces its old sessions.
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL").bind(t, userId, deviceId),
    db.prepare(`INSERT INTO sessions(id, user_id, device_id, client, access_hash, refresh_hash, created_at, seen_at, access_expires, idle_expires, max_expires, email_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(sid, userId, deviceId, client, await sha256(access), refresh ? await sha256(refresh) : null, t, t, t + ACCESS, t + IDLE, t + MAX, verifiedAt),
  ]);
  return { user_id: userId, device_id: deviceId, access_token: access, refresh_token: refresh, expires_in: ACCESS };
}
export function sessionResponse(result, client = "web") {
  if (!result) return error("too_many_devices", 409);
  if (client !== "web") return json(result);
  return Response.json({ user_id: result.user_id, device_id: result.device_id }, { headers: {
    "cache-control": "no-store", "set-cookie": `${COOKIE}=${result.access_token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${MAX}`,
  } });
}
export async function verifyEmail(req, env, body) {
  if (!enabled(env)) return error("accounts_unavailable", 503);
  if (!originOK(req, env)) return error("bad_origin", 403);
  const proof = await consumeChallenge(env, body, "login");
  if (!proof) return error("invalid_code", 401);
  const db = env.DB, t = now(), uid = `u_${random(24)}`;
  await db.prepare("INSERT INTO users(id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(uid, proof.email, t).run();
  const user = await db.prepare("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL").bind(proof.email).first();
  if (!user) return error("invalid_code", 401);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO groups(gid, created_at, seen_at) VALUES (?, ?, ?)").bind(user.id, t, t),
    db.prepare("INSERT OR IGNORE INTO account_configs(user_id) VALUES (?)").bind(user.id),
  ]);
  const previous = await authenticate(req, env);
  if (previous && previous.client === "web" && previous.user_id !== user.id) await db.batch(revokeDevice(db, previous.user_id, previous.device_id));
  // Token-bearing clients must use the PKCE exchange; email verification sets a browser session only.
  return sessionResponse(await makeSession(env, user.id, body, "web"));
}
// The stored nonce and server pepper reproduce an unused generation's tokens.
// Neither bearer token is stored in plaintext, and knowledge of the history
// hashes/nonce alone cannot recover them.
async function rotationTokens(env, sid, hash, nonce) {
  const token = async (kind) => {
    const value = await digest(env, `rotation:${sid}:${hash}:${nonce}:${kind}`);
    return btoa(String.fromCharCode(...value.match(/../g).map(x => parseInt(x, 16))))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  };
  const [access, refresh] = await Promise.all([token("access"), token("refresh")]);
  return { access, refresh };
}
export async function refreshSession(env, body) {
  if (!TOKEN.test(body.refresh_token || "")) return error("unauthorized", 401);
  const db = env.DB, t = now(), hash = await sha256(body.refresh_token);
  let s = await db.prepare(`SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN account_devices d ON d.id=s.device_id AND d.user_id=s.user_id
    WHERE s.refresh_hash=? AND s.revoked_at IS NULL AND u.deleted_at IS NULL AND d.revoked_at IS NULL
    AND s.idle_expires>? AND s.max_expires>?`).bind(hash, t, t).first();
  let previous = null;
  if (!s) {
    // Read history and its successor in one snapshot: a concurrent recovery
    // must not make an older nonce look like a stolen token generation.
    s = await db.prepare(`SELECT s.*, h.used_at AS previous_used_at, h.successor_hash, h.recovery_nonce
      FROM refresh_history h JOIN sessions s ON s.id=h.session_id JOIN users u ON u.id=s.user_id
      JOIN account_devices d ON d.id=s.device_id AND d.user_id=s.user_id
      WHERE h.hash=? AND s.revoked_at IS NULL AND u.deleted_at IS NULL AND d.revoked_at IS NULL
      AND s.idle_expires>? AND s.max_expires>?`).bind(hash, t, t).first();
    if (!s) return error("unauthorized", 401);
    previous = { used_at: s.previous_used_at, successor_hash: s.successor_hash, recovery_nonce: s.recovery_nonce };
    // Not recoverable: the successor was already used, or (a pre-migration rotation)
    // there is no derivation nonce to recover it with.
    if (!previous.recovery_nonce || previous.successor_hash !== s.refresh_hash || s.generation_used_at != null) {
      // A duplicate of a refresh that has only just gone through — two contexts of one
      // client racing, a request delivered twice — is not theft: as before, it waits.
      if (t - previous.used_at <= 15) return error("refresh_in_progress", 409);
      await db.prepare(`UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL
        AND (? IS NULL OR refresh_hash<>? OR generation_used_at IS NOT NULL)`)
        .bind(t, s.id, previous.successor_hash, previous.successor_hash).run();
      return error("unauthorized", 401);
    }
    if (s.access_expires > t) {
      const { access, refresh } = await rotationTokens(env, s.id, hash, previous.recovery_nonce);
      const kept = await db.prepare(`UPDATE sessions SET seen_at=?, idle_expires=MIN(max_expires, ?)
        WHERE id=? AND refresh_hash=? AND generation_used_at IS NULL AND revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM account_devices WHERE user_id=? AND id=? AND revoked_at IS NULL)
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL) RETURNING id`)
        .bind(t, t + IDLE, s.id, previous.successor_hash, s.user_id, s.device_id, s.user_id).first();
      if (!kept) return error("refresh_in_progress", 409);
      return json({ user_id: s.user_id, device_id: s.device_id, access_token: access, refresh_token: refresh, expires_in: s.access_expires - t });
    }
  }
  // An expired, unused successor gets a fresh generation. The old token remains
  // its recovery key until either newly issued token is actually used.
  const nonce = random(), { access, refresh } = await rotationTokens(env, s.id, hash, nonce);
  const accessHash = await sha256(access), refreshHash = await sha256(refresh);
  const active = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN account_devices d ON d.user_id=s.user_id AND d.id=s.device_id
    WHERE s.id=? AND s.refresh_hash=? AND s.revoked_at IS NULL AND u.deleted_at IS NULL
    AND d.revoked_at IS NULL AND s.idle_expires>? AND s.max_expires>?)`;
  const out = await db.batch([
    previous
      ? db.prepare(`UPDATE refresh_history SET used_at=?, recovery_nonce=?, successor_hash=?
          WHERE hash=? AND successor_hash=? AND ${active}
          AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND generation_used_at IS NULL)`)
        .bind(t, nonce, refreshHash, hash, s.refresh_hash, s.id, s.refresh_hash, t, t, s.id)
      : db.prepare(`INSERT OR IGNORE INTO refresh_history(hash, session_id, used_at, expires_at, recovery_nonce, successor_hash)
          SELECT ?, ?, ?, ?, ?, ? WHERE ${active}`).bind(hash, s.id, t, s.max_expires, nonce, refreshHash, s.id, s.refresh_hash, t, t),
    db.prepare(`UPDATE sessions SET access_hash=?, refresh_hash=?, access_expires=?, idle_expires=MIN(max_expires, ?), seen_at=?, generation_used_at=NULL
      WHERE id=? AND ${active}${previous ? " AND generation_used_at IS NULL" : ""}
      AND EXISTS(SELECT 1 FROM refresh_history WHERE hash=? AND recovery_nonce=? AND successor_hash=?)`)
      .bind(accessHash, refreshHash, t + ACCESS, t + IDLE, t, s.id, s.id, s.refresh_hash, t, t, hash, nonce, refreshHash),
  ]);
  if (!out[1].meta.changes) return error("refresh_in_progress", 409);
  return json({ user_id: s.user_id, device_id: s.device_id, access_token: access, refresh_token: refresh, expires_in: ACCESS });
}
export function validRedirect(env, uri) {
  if (typeof uri !== "string") return false;
  return (env.ACCOUNT_REDIRECTS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(uri);
}
export async function authorizeClient(env, session, body) {
  if (!validRedirect(env, body.redirect_uri) || !TOKEN.test(body.code_challenge || "") || !ID.test(body.device_id || "") ||
      !["extension", "ios", "macos", "android"].includes(body.platform)) return error("bad_callback");
  const code = random(), t = now();
  if (body.reauth === true && session.email_verified_at < t - 300) return error("fresh_login_required", 403);
  await env.DB.prepare(`INSERT INTO auth_codes(hash, user_id, device_id, platform, name, challenge, redirect_uri, created_at, expires_at, email_verified_at, source_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(code), session.user_id, body.device_id, body.platform, String(body.device_name || body.platform).slice(0, 80), body.code_challenge, body.redirect_uri, t, t + 60, session.email_verified_at, session.id).run();
  return json({ code, expires_in: 60 });
}
export async function exchangeClient(env, body) {
  if (!TOKEN.test(body.code || "") || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || "") || !validRedirect(env, body.redirect_uri)) return error("bad_callback");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(body.code_verifier)));
  const challenge = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const row = await env.DB.prepare(`UPDATE auth_codes SET consumed_at=? WHERE hash=? AND challenge=? AND redirect_uri=? AND consumed_at IS NULL AND expires_at>?
    AND EXISTS(SELECT 1 FROM users WHERE id=auth_codes.user_id AND deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM sessions s JOIN account_devices d ON d.user_id=s.user_id AND d.id=s.device_id
      WHERE s.id=auth_codes.source_session_id AND s.user_id=auth_codes.user_id AND s.revoked_at IS NULL AND d.revoked_at IS NULL) RETURNING *`)
    .bind(now(), await sha256(body.code), challenge, body.redirect_uri, now()).first();
  if (!row) return error("invalid_authorization", 401);
  return sessionResponse(await makeSession(env, row.user_id, { device_id: row.device_id, device_name: row.name, platform: row.platform }, "native", row.email_verified_at), "native");
}
export const clearCookie = (res) => {
  res.headers.set("set-cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`); return res;
};
export async function authRoutes(req, env) {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/v1/auth/")) return null;
  if (!["/v1/auth/email/start", "/v1/auth/email/verify", "/v1/auth/refresh", "/v1/auth/exchange", "/v1/auth/authorize"].includes(path)) return null;
  if (req.method !== "POST") return error("not_found", 404);
  if (path !== "/v1/auth/refresh" && !enabled(env)) return error("accounts_unavailable", 503);
  if (!originOK(req, env)) return error("bad_origin", 403);
  let body; try { body = await readBody(req); } catch { return error("bad_body"); }
  if (path === "/v1/auth/email/start") return startEmail(req, env, body);
  if (path === "/v1/auth/email/verify") return verifyEmail(req, env, body);
  if (path === "/v1/auth/refresh") return refreshSession(env, body);
  if (path === "/v1/auth/exchange") return exchangeClient(env, body);
  if (path === "/v1/auth/authorize") {
    const session = await authenticate(req, env);
    return session ? authorizeClient(env, session, body) : error("unauthorized", 401);
  }
  return null;
}
export function authCleanup(db, t) {
  return [
    db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(t - 86400),
    db.prepare("DELETE FROM auth_budgets WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM refresh_history WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM sessions WHERE max_expires < ? OR idle_expires < ? OR revoked_at < ?").bind(t, t, t - 86400),
  ];
}
