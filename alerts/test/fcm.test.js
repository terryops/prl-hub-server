// FCM (fcm.js) and the Android registration on PUT /v1/web/push.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, installFetch, setNow, restoreNow, T0, tick } from "./helpers.js";
import { seedSession } from "./account-fixture.js";
import { send, fcmConfigured, resetTokenCache, dataFor } from "../src/fcm.js";
import { payloadFor, deferredPayloadFor, offlinePayloadFor } from "../src/i18n.js";
import { b64 } from "../src/webpush.js";
import { revokeDevice } from "../src/account-lifecycle.js";
import { sha256 } from "../src/http.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROJECT = "prl-hub-test";
const SEND_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`;
const REG = "dRk9Q3v_T0m:APA91bH" + "x".repeat(140);
const REG2 = "eZz1Q3v_T0m:APA91bH" + "y".repeat(140);
const AUTH = "A".repeat(43);
const headers = { Authorization: `Bearer ${AUTH}` };
const gid = await sha256(AUTH);
const addr = "prl1" + "a".repeat(38);

const rsa = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", rsa.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const SA = JSON.stringify({
  type: "service_account", project_id: PROJECT, private_key_id: "key-1", private_key: PEM,
  client_email: "push@prl-hub-test.iam.gserviceaccount.com", token_uri: TOKEN_URL,
});

const realFetch = globalThis.fetch;
beforeEach(() => resetTokenCache());
afterEach(() => { restoreNow(); globalThis.fetch = realFetch; });

const fcmEnv = (extra = {}) => makeEnv({ FCM_SERVICE_ACCOUNT: SA, ...extra });

/// installFetch() plus Google: the token endpoint answers `tokenReply()` (default a
/// fresh "at-<n>" for an hour), FCM answers `fcmReply(call)` (default 200).
function mockGoogle() {
  const mocks = installFetch(), base = globalThis.fetch;
  const state = {
    mocks, tokens: [], sends: [],
    tokenReply: () => ({ status: 200, body: { access_token: `at-${state.tokens.length}`, expires_in: 3600, token_type: "Bearer" } }),
    fcmReply: () => ({ status: 200, body: { name: `projects/${PROJECT}/messages/0:1` } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === TOKEN_URL) {
      state.tokens.push({ init, form: new URLSearchParams(init.body) });
      const r = await state.tokenReply();
      if (r.throw) throw new Error("network down");
      return Response.json(r.body ?? {}, { status: r.status });
    }
    if (u.startsWith("https://fcm.googleapis.com/v1/")) {
      const c = { url: u, headers: init.headers, body: JSON.parse(init.body) };
      state.sends.push(c);
      const r = await state.fcmReply(c);
      if (r.throw) throw new Error("network down");
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }
    return base(url, init);
  };
  return state;
}

const seedPro = async (env, pro = true) => {
  await seedSession(env, AUTH);
  env.DB.raw.prepare("INSERT OR REPLACE INTO groups (gid, created_at, seen_at, pro_at, pro_src) VALUES (?, ?, ?, ?, 'admin')")
    .run(gid, T0, T0, pro ? T0 : null);
};
const putFCM = (env, extra = {}, h = headers) =>
  call(env, "PUT", "/v1/web/push", { fcm: { token: REG }, lang: "en", rules: [], watches: [], ...extra }, h);
const unb64url = (s) => Buffer.from(s, "base64url");
const fcmError = (code, status, extra = {}) =>
  ({ error: { code, status, message: "x", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: status }], ...extra } });

test("fcm: configured only by a complete service-account JSON", () => {
  assert.equal(fcmConfigured({}), false);
  assert.equal(fcmConfigured({ FCM_SERVICE_ACCOUNT: "not json" }), false);
  assert.equal(fcmConfigured({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p", client_email: "e" }) }), false);
  assert.equal(fcmConfigured({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p", client_email: "e", private_key: 1 }) }), false);
  assert.equal(fcmConfigured({ FCM_SERVICE_ACCOUNT: SA }), true);
});

test("fcm: the JWT-bearer grant is RS256 with the documented claims and verifies with the public key", async () => {
  setNow(T0);
  const g = mockGoogle();
  const out = await send(fcmEnv(), REG, payloadFor("en", null, 0.8));
  assert.deepEqual(out, { ok: true, env: "production" });
  assert.equal(g.tokens.length, 1);
  const { init, form } = g.tokens[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, c, s] = form.get("assertion").split(".");
  assert.deepEqual(JSON.parse(unb64url(h)), { alg: "RS256", typ: "JWT", kid: "key-1" });
  assert.deepEqual(JSON.parse(unb64url(c)), {
    iss: "push@prl-hub-test.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: TOKEN_URL, iat: T0, exp: T0 + 3600,
  });
  assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", rsa.publicKey, unb64url(s), new TextEncoder().encode(`${h}.${c}`)));
  assert.equal(g.sends[0].headers.authorization, "Bearer at-1");
});

test("fcm: one access token serves every send until a minute before it expires", async () => {
  setNow(T0);
  const g = mockGoogle(), env = fcmEnv(), p = payloadFor("en", null, 0.8);
  await send(env, REG, p);
  await send(env, REG, p);
  assert.equal(g.tokens.length, 1, "two sends, one token request");
  // A tick's concurrent pushes share one mint.
  resetTokenCache();
  await Promise.all(Array.from({ length: 5 }, () => send(env, REG, p)));
  assert.equal(g.tokens.length, 2);
  setNow(T0 + 3539);
  await send(env, REG, p);
  assert.equal(g.tokens.length, 2, "still fresh");
  setNow(T0 + 3541);
  await send(env, REG, p);
  assert.equal(g.tokens.length, 3, "refreshed 60 s before expiry");
  assert.equal(g.sends.at(-1).headers.authorization, "Bearer at-3");
  assert.equal(JSON.parse(unb64url(g.tokens[2].form.get("assertion").split(".")[1])).iat, T0 + 3541);
});

test("fcm: a data-only message with string values, priority, ttl and collapse key", async () => {
  setNow(T0);
  const g = mockGoogle(), env = fcmEnv();
  const rule = { id: "r1", kind: "above", value: 0.7 };
  const price = payloadFor("en", rule, 0.8, 0);
  await send(env, REG, price, { collapseId: "r1" });
  assert.equal(g.sends[0].url, SEND_URL);
  assert.equal(g.sends[0].headers["content-type"], "application/json");
  const m = g.sends[0].body.message;
  assert.deepEqual(Object.keys(g.sends[0].body), ["message"]);
  assert.equal(m.notification, undefined, "data-only: the app builds the notification");
  assert.equal(m.token, REG);
  assert.deepEqual(m.data, { title: price.aps.alert.title, body: price.aps.alert.body, kind: "price", tag: "r1", route: "market" });
  assert.equal(m.data.title, "PRL above $0.70");
  assert.ok(Object.values(m.data).every((v) => typeof v === "string"));
  assert.deepEqual(m.android, { priority: "HIGH", ttl: "3600s", collapse_key: "r1" });

  await send(env, REG, payloadFor("en", null, 0.8), { priority: 5, ttl: 300 });
  assert.deepEqual(g.sends[1].body.message.android, { priority: "NORMAL", ttl: "300s", collapse_key: "test" });
  assert.equal(g.sends[1].body.message.data.kind, "test");
  assert.equal(g.sends[1].body.message.data.route, "alerts");

  const watch = { id: "w1", pool: "AlphaPool", label: "Rig room" };
  const down = offlinePayloadFor("en", watch, [{ name: "gpu-1", since: T0 - 900 }], T0);
  await send(env, REG, down, { ttl: 4 * 3600 });
  const d = g.sends[2].body.message;
  assert.deepEqual({ kind: d.data.kind, tag: d.data.tag, route: d.data.route }, { kind: "offline", tag: "worker:w1", route: "workers" });
  assert.equal(d.data.title, down.aps.alert.title);
  assert.equal(d.data.body, `Rig room\n${down.aps.alert.body}`);
  assert.deepEqual(d.android, { priority: "HIGH", ttl: "14400s", collapse_key: "worker:w1" });

  // An alert queued through quiet hours is still a price alert for its rule.
  const later = dataFor(deferredPayloadFor("en", { rule_id: "r2", kind: "below", value: 0.5 }, 0.4, "03:00"), { collapseId: "r2" });
  assert.deepEqual({ kind: later.kind, tag: later.tag, route: later.route }, { kind: "price", tag: "r2", route: "market" });
});

test("fcm: results map to ok / drop / retry / fail as the other channels' do", async () => {
  setNow(T0);
  const g = mockGoogle(), env = fcmEnv(), p = payloadFor("en", null, 0.8);
  const tokenField = { details: [
    { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
    { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message.token", description: "Invalid registration token" }] },
  ] };
  const cases = [
    [{ status: 200, body: {} }, { ok: true, env: "production" }],
    [{ status: 404, body: fcmError(404, "UNREGISTERED") }, { ok: false, drop: true, status: 404, reason: "UNREGISTERED" }],
    [{ status: 404 }, { ok: false, drop: true, status: 404, reason: "unregistered" }],
    [{ status: 400, body: fcmError(400, "INVALID_ARGUMENT", tokenField) }, { ok: false, drop: true, status: 400, reason: "invalid registration token" }],
    [{ status: 400, body: fcmError(400, "INVALID_ARGUMENT", { message: "The registration token is not a valid FCM registration token" }) },
     { ok: false, drop: true, status: 400, reason: "invalid registration token" }],
    [{ status: 400, body: fcmError(400, "INVALID_ARGUMENT", { message: "Message is too big" }) }, { ok: false, fail: true, status: 400, reason: "INVALID_ARGUMENT" }],
    [{ status: 429, body: fcmError(429, "QUOTA_EXCEEDED"), headers: { "retry-after": "120" } },
     { ok: false, retry: true, status: 429, backoff: 120, reason: "QUOTA_EXCEEDED" }],
    [{ status: 429 }, { ok: false, retry: true, status: 429, backoff: 60, reason: "quota exceeded" }],
    [{ status: 500, body: fcmError(500, "INTERNAL") }, { ok: false, retry: true, status: 500, reason: "INTERNAL" }],
    [{ status: 503, body: fcmError(503, "UNAVAILABLE") }, { ok: false, retry: true, status: 503, reason: "UNAVAILABLE" }],
    [{ status: 403, body: fcmError(403, "SENDER_ID_MISMATCH") }, { ok: false, fail: true, status: 403, reason: "SENDER_ID_MISMATCH" }],
    [{ throw: true }, { ok: false, retry: true, reason: "fcm request failed" }],
  ];
  for (const [reply, want] of cases) {
    g.fcmReply = () => reply;
    assert.deepEqual(await send(env, REG, p), want, JSON.stringify(reply));
  }

  // 401: the access token is minted again once; still refused → an auth problem, not a dead device.
  g.fcmReply = () => ({ status: 401, body: fcmError(401, "UNAUTHENTICATED") });
  const before = g.tokens.length, sends = g.sends.length;
  assert.deepEqual(await send(env, REG, p), { ok: false, fail: true, status: 401, reason: "UNAUTHENTICATED" });
  assert.equal(g.tokens.length - before, 1);
  assert.equal(g.sends.length - sends, 2);
  // …and a 401 that a fresh token cures is delivered.
  let n = 0;
  g.fcmReply = () => (n++ ? { status: 200 } : { status: 401 });
  assert.deepEqual(await send(env, REG, p), { ok: true, env: "production" });

  // The token endpoint: a refused key fails, Google being down retries.
  for (const [reply, want] of [
    [{ status: 400, body: { error: "invalid_grant" } }, { ok: false, fail: true, status: 400, reason: "fcm auth refused" }],
    [{ status: 503 }, { ok: false, retry: true, status: 503, reason: "fcm auth unavailable" }],
    [{ throw: true }, { ok: false, retry: true, reason: "fcm auth failed" }],
  ]) {
    resetTokenCache();
    g.tokenReply = () => reply;
    assert.deepEqual(await send(env, REG, p), want, JSON.stringify(reply));
  }
  assert.deepEqual(await send(makeEnv(), REG, p), { ok: false, fail: true, reason: "fcm not configured" });
  resetTokenCache();
  assert.deepEqual(await send(fcmEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify({ ...JSON.parse(SA), private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }) }), REG, p),
    { ok: false, fail: true, reason: "invalid FCM configuration" });
});

test("fcm: PUT /v1/web/push registers an Android device behind the web push rules", async () => {
  setNow(T0);
  mockGoogle();
  const env = fcmEnv();
  await seedPro(env, false);
  assert.deepEqual((await putFCM(env)).body, { error: "not_pro" });
  assert.equal((await putFCM(env)).status, 403);
  await seedPro(env);
  const off = makeEnv();
  await seedPro(off);
  assert.deepEqual(await putFCM(off), { status: 503, body: { error: "push_off" } });

  for (const bad of [{ token: "short" }, { token: "x".repeat(4097) }, { token: REG + " " }, { token: REG.replace("_", "/") }, { token: 42 }, {}, "tok"]) {
    assert.deepEqual(await putFCM(env, { fcm: bad }), { status: 400, body: { error: "bad subscription" } }, JSON.stringify(bad));
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const both = fcmEnv({ VAPID_PUBLIC: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    VAPID_PRIVATE: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d, VAPID_SUBJECT: "mailto:owner@example.com" });
  await seedPro(both);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/one", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };
  assert.deepEqual(await putFCM(both, { subscription: sub }), { status: 400, body: { error: "bad subscription" } }, "both");
  assert.deepEqual(await call(both, "PUT", "/v1/web/push", { rules: [] }, headers), { status: 400, body: { error: "bad subscription" } }, "neither");
  assert.equal(both.DB.one("SELECT COUNT(*) n FROM devices").n, 0);

  const rules = [{ id: "r1", kind: "above", value: 1.5, enabled: true }];
  const watches = [{ id: "w1", pool: "AlphaPool", addr, label: "Rig room", after: 600 }];
  const r = await putFCM(env, { rules, watches, window: { start: 480, end: 1320, tz: "Asia/Shanghai" } });
  assert.equal(r.status, 200);
  const token = await sha256(`fcm:${REG}`);
  assert.equal(r.body.token, token);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.rules.map((x) => x.id), ["r1"]);
  assert.deepEqual(r.body.watches.map((x) => x.id), ["w1"]);
  assert.deepEqual(env.DB.one("SELECT chan, topic, env, gid, lang, oneshot, win_start, win_end, tz FROM devices WHERE token = ?", token),
    { chan: "fcm", topic: "android", env: "production", gid, lang: "en", oneshot: 1, win_start: 480, win_end: 1320, tz: "Asia/Shanghai" });
  assert.deepEqual(env.DB.rows("SELECT token, reg FROM fcm"), [{ token, reg: REG }]);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM webpush").n, 0);
  // Re-registering the same token is an update.
  assert.equal((await putFCM(env, { rules: [] })).status, 200);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM rules").n, 0);
  // The app's own APNs-style route is closed to it.
  assert.deepEqual(await call(env, "PUT", `/v1/devices/${token}`, { env: "production", topic: "com.prl.wizard", rules: [] }, headers),
    { status: 409, body: { error: "web device" } });

  // A rotated FCM token replaces the installation's old one.
  const r2 = await putFCM(env, { fcm: { token: REG2 } });
  assert.equal(r2.status, 200);
  assert.deepEqual(env.DB.rows("SELECT token, reg FROM fcm"), [{ token: r2.body.token, reg: REG2 }]);
  assert.deepEqual(env.DB.rows("SELECT token FROM devices"), [{ token: r2.body.token }]);

  // A token already held by a browser subscription is not taken over.
  const taken = await sha256(`fcm:${REG}`);
  env.DB.raw.prepare("INSERT INTO devices (token, env, topic, updated_at, chan, gid) VALUES (?, 'production', 'web', ?, 'webpush', ?)").run(taken, T0, gid);
  assert.deepEqual(await putFCM(env), { status: 409, body: { error: "device conflict" } });
  assert.equal(env.DB.one("SELECT chan FROM devices WHERE token = ?", taken).chan, "webpush");
});

test("fcm: Android devices share the account's ten-device cap", async () => {
  setNow(T0);
  mockGoogle();
  const env = fcmEnv();
  await seedPro(env);
  const install = async (i) => {
    const bearer = "C".repeat(40) + String(i).padStart(3, "0");
    await seedSession(env, bearer, gid, `fixture-android-${String(i).padStart(4, "0")}`);
    return { Authorization: `Bearer ${bearer}` };
  };
  for (let i = 0; i < 10; i++) {
    assert.equal((await putFCM(env, { fcm: { token: `${REG}${i}` } }, await install(i))).status, 200, `device ${i}`);
  }
  assert.deepEqual(await putFCM(env, { fcm: { token: `${REG}x` } }, await install(10)), { status: 409, body: { error: "device_conflict" } });
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM devices WHERE chan = 'fcm'").n, 10);
  // An existing device at the cap still updates.
  assert.equal((await putFCM(env, { fcm: { token: `${REG}0` } }, await install(0))).status, 200);
});

test("fcm: a fired price rule reaches FCM; a retry re-arms it; UNREGISTERED forgets the device", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  delete env.APNS_KEY;
  await seedPro(env);
  const logs = [], saved = [console.log, console.error, console.warn];
  for (const k of ["log", "error", "warn"]) console[k] = (...a) => logs.push(a.join(" "));
  try {
    const r = await putFCM(env, { oneshot: false, rules: [{ id: "up", kind: "above", value: 0.7, enabled: true }] });
    assert.equal(r.status, 200);
    await tick(env);
    assert.equal(g.sends.length, 1);
    const m = g.sends[0].body.message;
    assert.equal(m.token, REG);
    assert.deepEqual({ kind: m.data.kind, tag: m.data.tag, route: m.data.route }, { kind: "price", tag: "up", route: "market" });
    assert.deepEqual(m.android, { priority: "HIGH", ttl: "3600s", collapse_key: "up" });
    assert.equal(m.data.title, "PRL above $0.70");
    assert.equal(env.DB.one("SELECT enabled FROM rules").enabled, 0, "one-shot: switched off once pushed");

    // FCM busy: the rule is put back for the next tick.
    await putFCM(env, { rules: [{ id: "up2", kind: "above", value: 0.7, enabled: true }] });
    g.fcmReply = () => ({ status: 503, body: fcmError(503, "UNAVAILABLE") });
    setNow(T0 + 60);
    await tick(env);
    assert.equal(g.sends.length, 2);
    assert.deepEqual(env.DB.one("SELECT enabled, armed FROM rules WHERE id = 'up2'"), { enabled: 1, armed: 1 });

    g.fcmReply = () => ({ status: 404, body: fcmError(404, "UNREGISTERED") });
    setNow(T0 + 120);
    await tick(env);
    assert.equal(g.sends.length, 3);
    for (const table of ["devices", "fcm", "rules", "deferred", "watches"]) assert.equal(env.DB.one(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
  } finally {
    [console.log, console.error, console.warn] = saved;
  }
  const all = logs.join("\n");
  assert.ok(!/at-\d/.test(all), "an access token was logged");
  assert.ok(!all.includes(der.slice(0, 40)), "the private key was logged");
});

test("fcm: an Android device with watches, silent for 30 days, gets a ping that keeps it; a dead one goes", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  delete env.APNS_KEY; // FCM alone runs the check too
  await seedPro(env);
  g.mocks.pool = async () => Response.json({ last_seen: Date.now() / 1000, workers: [{ name: "gpu-1", online: true, time: Date.now() / 1000 }] });
  assert.equal((await putFCM(env, { watches: [{ id: "w1", pool: "AlphaPool", addr, label: "Rig room", after: 600 }] })).status, 200);
  const token = await sha256(`fcm:${REG}`);
  const idle = T0 + 31 * 86400; // on the hour, when the idle check runs
  setNow(idle);
  await tick(env);
  const pings = g.sends.filter((c) => c.body.message.data.kind === "ping");
  assert.equal(pings.length, 1);
  // Neither title nor body: the app drops it unshown.
  assert.deepEqual(pings[0].body.message.data, { kind: "ping" });
  assert.deepEqual(pings[0].body.message.android, { priority: "NORMAL", ttl: "60s" });
  assert.equal(env.DB.one("SELECT seen_at FROM devices WHERE token = ?", token).seen_at, idle);
  // Kept past the 90 days since it last opened the app, as long as FCM still takes the pings.
  setNow(idle + 31 * 86400); await tick(env);
  setNow(idle + 62 * 86400); await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM watches").n, 1, "still watched after 93 days");
  g.fcmReply = () => ({ status: 404, body: fcmError(404, "UNREGISTERED") });
  setNow(idle + 93 * 86400); await tick(env);
  for (const table of ["devices", "fcm", "watches"]) assert.equal(env.DB.one(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
});

test("fcm: an offline alert and the recovery reach FCM", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  await seedPro(env);
  let online = true;
  g.mocks.pool = async () => Response.json({ last_seen: T0, workers: [{ name: "gpu-1", online, time: T0 + 1 }] });
  const r = await putFCM(env, { watches: [{ id: "w1", pool: "AlphaPool", addr, label: "Rig room", after: 600 }] });
  assert.equal(r.status, 200);
  await tick(env);
  assert.equal(g.sends.length, 0);
  online = false;
  setNow(T0 + 660);
  await tick(env);
  assert.equal(g.sends.length, 1);
  const m = g.sends[0].body.message;
  assert.deepEqual({ kind: m.data.kind, tag: m.data.tag, route: m.data.route }, { kind: "offline", tag: "worker:w1", route: "workers" });
  assert.deepEqual(m.android, { priority: "HIGH", ttl: "14400s", collapse_key: "worker:w1" });
  assert.match(m.data.title, /gpu-1 offline/);
  assert.match(m.data.body, /^Rig room\nOffline for /);
  online = true;
  for (const at of [1020, 1080]) { setNow(T0 + at); await tick(env); }
  assert.equal(g.sends.length, 2);
  const back = g.sends[1].body.message.data;
  assert.deepEqual({ kind: back.kind, tag: back.tag, route: back.route }, { kind: "offline", tag: "worker:w1", route: "workers" });
  assert.match(back.title, /gpu-1 back online/);
});

test("fcm: test push, DELETE, account revocation and /v1/web/status", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  await seedPro(env);
  assert.equal((await call(env, "GET", "/v1/web/status")).body.fcm, true);
  assert.equal((await call(makeEnv(), "GET", "/v1/web/status")).body.fcm, false);
  assert.equal((await call(fcmEnv({ FCM_SERVICE_ACCOUNT: "{}" }), "GET", "/v1/web/status")).body.fcm, false);

  const { body: { token } } = await putFCM(env, { lang: "zh-Hans" });
  const sent = await call(env, "POST", `/v1/devices/${token}/test`, undefined, headers);
  assert.deepEqual(sent, { status: 200, body: { ok: true, env: "production" } });
  const m = g.sends[0].body.message;
  assert.deepEqual({ kind: m.data.kind, tag: m.data.tag, route: m.data.route }, { kind: "test", tag: "test", route: "alerts" });
  assert.equal(m.data.title, payloadFor("zh-Hans", null, 0).aps.alert.title);
  assert.equal((await call(env, "POST", `/v1/devices/${token}/test`, undefined, headers)).status, 429);
  const saved = env.FCM_SERVICE_ACCOUNT;
  delete env.FCM_SERVICE_ACCOUNT;
  setNow(T0 + 61);
  assert.deepEqual(await call(env, "POST", `/v1/devices/${token}/test`, undefined, headers), { status: 503, body: { error: "fcm not configured" } });
  env.FCM_SERVICE_ACCOUNT = saved;
  assert.equal((await call(env, "GET", `/v1/devices/${token}`, undefined, headers)).status, 200);

  assert.deepEqual(await call(env, "DELETE", `/v1/devices/${token}`, undefined, headers), { status: 200, body: { ok: true } });
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM fcm").n, 0);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM devices").n, 0);

  // A dead token found by the test push is forgotten.
  const again = await putFCM(env);
  g.fcmReply = () => ({ status: 404, body: fcmError(404, "UNREGISTERED") });
  setNow(T0 + 200);
  assert.equal((await call(env, "POST", `/v1/devices/${again.body.token}/test`, undefined, headers)).status, 502);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM fcm").n, 0);

  // Signing the installation out removes its Android registration.
  assert.equal((await putFCM(env)).status, 200);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM fcm").n, 1);
  await env.DB.batch(revokeDevice(env.DB, gid, "fixture-device-0001", T0 + 300));
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM fcm").n, 0);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM devices").n, 0);
});

// 锁屏盯盘 on Android: the phone registers its FCM token on the iOS activity's route, topic 'android',
// under the token /v1/web/push files that registration under.
const liveToken = await sha256(`fcm:${REG}`);
const putLive = (env, extra = {}, h = headers, token = liveToken) =>
  call(env, "PUT", `/v1/live/${token}`, { topic: "android", env: "production", fcm: { token: REG }, started_at: T0, ...extra }, h);

test("fcm live: an Android ticker gets the moved price at high priority and a heartbeat at normal", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  delete env.APNS_KEY;
  await seedPro(env);
  assert.deepEqual(await putLive(env), { status: 200, body: { ok: true } });
  assert.deepEqual(env.DB.one("SELECT topic, env, reg, started_at, account_pro FROM live WHERE token = ?", liveToken),
    { topic: "android", env: "production", reg: REG, started_at: T0, account_pro: 1 });
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM fcm").n, 0, "price alerts stay off");

  await tick(env);
  assert.equal(g.sends.length, 1);
  const m = g.sends[0].body.message;
  assert.equal(m.token, REG);
  assert.equal(m.notification, undefined);
  assert.deepEqual(m.android, { priority: "HIGH", ttl: "300s", collapse_key: "live" });
  assert.equal(m.data.kind, "live");
  assert.equal(m.data.usd, "0.8");
  assert.equal(m.data.at, String(T0));
  assert.ok(Object.values(m.data).every((v) => typeof v === "string"), "FCM data values are strings");

  // Unchanged price: nothing until the heartbeat, which goes at normal priority.
  setNow(T0 + 60);
  await tick(env);
  assert.equal(g.sends.length, 1);
  setNow(T0 + 660);
  await tick(env);
  assert.equal(g.sends.length, 2);
  assert.equal(g.sends[1].body.message.android.priority, "NORMAL");

  // After 8 hours the Worker stops, as for an iOS activity.
  setNow(T0 + 8 * 3600 + 60);
  g.mocks.price = 0.9;
  await tick(env);
  assert.equal(g.sends.length, 2);
});

test("fcm live: registration checks — token match, Pro, session, FCM configured — and DELETE", async () => {
  setNow(T0);
  mockGoogle();
  const env = fcmEnv();
  await seedPro(env, false);
  assert.equal((await putLive(env)).status, 403, "not Pro");
  await seedPro(env);
  assert.equal((await putLive(env, {}, headers, await sha256(`fcm:${REG2}`))).status, 400, "the token must be the registration's");
  assert.equal((await putLive(env, { fcm: { token: "short" } })).status, 400);
  assert.equal((await putLive(env, {}, {})).status, 401, "signed out");
  const saved = env.FCM_SERVICE_ACCOUNT;
  env.FCM_SERVICE_ACCOUNT = "{}";
  assert.equal((await putLive(env)).status, 503, "FCM not configured");
  env.FCM_SERVICE_ACCOUNT = saved;
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM live").n, 0);

  assert.equal((await putLive(env)).status, 200);
  // Re-registered while the same ticker runs (app relaunch): the phone sends that ticker's start again.
  assert.equal((await putLive(env, { started_at: T0 })).status, 200);
  assert.equal(env.DB.one("SELECT started_at FROM live").started_at, T0);
  // Stopped where the Worker never heard of it, started again hours later: one token per phone, so the
  // new ticker's own start counts, and it gets its 8 hours (iOS keeps MIN: a token there is one activity).
  setNow(T0 + 6 * 3600);
  assert.equal((await putLive(env, { started_at: T0 + 6 * 3600 })).status, 200);
  assert.equal(env.DB.one("SELECT started_at FROM live").started_at, T0 + 6 * 3600);
  assert.deepEqual(await call(env, "DELETE", `/v1/live/${liveToken}`, undefined, headers), { status: 200, body: { ok: true } });
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM live").n, 0);
});

test("fcm live: alerts and the ticker share the phone's claim; signing out removes both", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  await seedPro(env);
  const { body: { token } } = await putFCM(env);
  assert.equal(token, liveToken, "one phone, one token");
  assert.equal((await putLive(env)).status, 200);
  assert.equal(env.DB.one("SELECT kind FROM account_push_claims WHERE token = ?", liveToken).kind, "notification");
  // Price alerts off: the ticker keeps its own registration.
  assert.equal((await call(env, "DELETE", `/v1/devices/${token}`, undefined, headers)).status, 200);
  await tick(env);
  assert.equal(g.sends.filter((s) => s.body.message.data.kind === "live").length, 1);
  await env.DB.batch(revokeDevice(env.DB, gid, "fixture-device-0001", T0 + 30));
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM live").n, 0);
});

test("fcm live: a dead registration drops the ticker; a lapsed Pro stops it", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  await seedPro(env);
  assert.equal((await putLive(env)).status, 200);
  g.fcmReply = () => ({ status: 404, body: fcmError(404, "UNREGISTERED") });
  await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM live").n, 0);

  g.fcmReply = () => ({ status: 200, body: {} });
  setNow(T0 + 60);
  assert.equal((await putLive(env)).status, 200);
  env.DB.raw.prepare("UPDATE groups SET pro_at = NULL WHERE gid = ?").run(gid);
  const before = g.sends.length;
  setNow(T0 + 120);
  g.mocks.price = 0.85;
  await tick(env);
  assert.equal(g.sends.length, before, "no push without Pro");
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM live").n, 0);
});

test("fcm live: the website APK's purchase credential registers the ticker of PRL-bought Pro", async () => {
  setNow(T0);
  const g = mockGoogle();
  const env = fcmEnv();
  const r = await call(env, "POST", "/v1/purchase/session", { device_id: "d".repeat(24) }, { Origin: "https://prl.test" });
  assert.equal(r.status, 200);
  // The app's fetches carry the page's Origin, which purchase credentials require on writes.
  const buyer = { "X-Purchase-Key": r.body.purchase_key, "X-Account-ID": r.body.purchase_id, Origin: "https://prl.test" };
  assert.equal((await putLive(env, {}, buyer)).status, 403, "no purchase yet");
  env.DB.raw.prepare("INSERT INTO orders (id, gid, usd, rate, sats, created_at, expires_at, status, txid, paid_at) VALUES ('o1', ?, 4.99, 0.8, 623750000, ?, ?, 'paid', ?, ?)")
    .run(r.body.purchase_id, T0, T0 + 900, "c".repeat(64), T0);
  assert.deepEqual(await putLive(env, {}, buyer), { status: 200, body: { ok: true } });
  assert.equal(env.DB.one("SELECT account_pro FROM live").account_pro, 0);
  await tick(env);
  assert.equal(g.sends.filter((s) => s.body.message.data.kind === "live").length, 1);
  assert.deepEqual(await call(env, "DELETE", `/v1/live/${liveToken}`, undefined, buyer), { status: 200, body: { ok: true } });
});
