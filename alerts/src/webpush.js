// RFC 8291 aes128gcm and RFC 8292 VAPID, using only Workers WebCrypto.
const enc = new TextEncoder();
export const b64 = (a) =>
  btoa(String.fromCharCode(...new Uint8Array(a)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const unb64 = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const cat = (...xs) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of xs) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
export const configured = (env) =>
  !!(env.VAPID_PRIVATE && env.VAPID_PUBLIC && env.VAPID_SUBJECT);
const alg = { name: "ECDH", namedCurve: "P-256" };
export async function importPair(publicKey, privateKey, algorithm = alg) {
  const raw = unb64(publicKey);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64(raw.slice(1, 33)),
      y: b64(raw.slice(33)),
      d: privateKey,
      ext: true,
    },
    algorithm,
    true,
    algorithm.name === "ECDH" ? ["deriveBits"] : ["sign"],
  );
}
async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      length * 8,
    ),
  );
}
export async function encrypt(plaintext, subscription, options = {}) {
  const bytes =
    typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  if (bytes.length > 3993) throw new Error("payload too large");
  const ua = unb64(subscription.p256dh),
    auth = unb64(subscription.auth);
  const receiver = await crypto.subtle.importKey("raw", ua, alg, false, []);
  const pair =
    options.keyPair ||
    (await crypto.subtle.generateKey(alg, true, ["deriveBits"]));
  const pub = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiver },
      pair.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    shared,
    auth,
    cat(enc.encode("WebPush: info\0"), ua, pub),
    32,
  );
  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    ikm,
    salt,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      cat(bytes, new Uint8Array([2])),
    ),
  );
  return cat(salt, new Uint8Array([0, 0, 16, 0, 65]), pub, ciphertext);
}
export async function vapid(env, endpoint, t = Math.floor(Date.now() / 1000)) {
  const head = b64(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: t + 12 * 3600,
        sub: env.VAPID_SUBJECT,
      }),
    ),
  );
  const key = await importPair(env.VAPID_PUBLIC, env.VAPID_PRIVATE, {
    name: "ECDSA",
    namedCurve: "P-256",
  });
  const unsigned = `${head}.${body}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(unsigned),
  );
  return `${unsigned}.${b64(signature)}`;
}
export async function validateSubscription(s) {
  try {
    const u = new URL(s?.endpoint);
    const allowed =
      [
        "fcm.googleapis.com",
        "jmt17.google.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
      ].includes(u.hostname) || /^.+\.notify\.windows\.com$/.test(u.hostname);
    if (!allowed) console.log("push host rejected", u.hostname.slice(0, 100));
    if (
      !allowed ||
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      s.endpoint.length > 2048
    )
      return null;
    if (
      !/^[A-Za-z0-9_-]{87}$/.test(s.keys?.p256dh) ||
      !/^[A-Za-z0-9_-]{22}$/.test(s.keys?.auth)
    )
      return null;
    const pub = unb64(s.keys.p256dh);
    if (pub.length !== 65 || pub[0] !== 4 || unb64(s.keys.auth).length !== 16)
      return null;
    await crypto.subtle.importKey("raw", pub, alg, false, []);
    return { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth };
  } catch {
    return null;
  }
}
export async function send(env, subscription, payload, opts = {}) {
  if (!configured(env))
    return { ok: false, fail: true, reason: "webpush not configured" };
  const alert = payload.aps?.alert || {};
  let plaintext;
  try {
    plaintext = JSON.stringify({
      title: alert.title || "Pearl Hub",
      // A browser notification has no subtitle: it leads the body, on a line of its own.
      body: [alert.subtitle, alert.body].filter(Boolean).join("\n"),
      tag: payload.watch?.id ? `worker:${payload.watch.id}` : opts.collapseId || payload.aps?.["thread-id"] || "pearl-hub",
      url: payload.aps?.["thread-id"] === "worker-offline" ? "/#workers" : "/#alerts",
    });
  } catch { return { ok: false, fail: true, reason: "invalid payload" }; }
  if (enc.encode(plaintext).length > 3993) return { ok: false, fail: true, reason: "payload too large" };
  let body, token;
  try { body = await encrypt(plaintext, subscription); }
  catch { return { ok: false, drop: true, reason: "invalid subscription keys" }; }
  try { token = await vapid(env, subscription.endpoint); }
  catch { return { ok: false, fail: true, reason: "invalid VAPID configuration" }; }
  try {
    const r = await fetch(subscription.endpoint, {
      method: "POST",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        TTL: String(opts.ttl ?? 3600),
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC}`,
      },
    });
    if (r.status === 201) return { ok: true, env: "production" };
    if ([401, 403, 404, 410].includes(r.status))
      return {
        ok: false,
        drop: true,
        status: r.status,
        reason: "subscription gone",
      };
    if (r.status === 429 || r.status >= 500)
      return {
        ok: false,
        retry: true,
        status: r.status,
        backoff:
          r.status === 429
            ? Math.min(
                3600,
                Math.max(60, Number(r.headers.get("retry-after")) || 60),
              )
            : undefined,
        reason: "push unavailable",
      };
    return { ok: false, fail: true, status: r.status, reason: "push refused" };
  } catch {
    return { ok: false, retry: true, reason: "push failed" };
  }
}
