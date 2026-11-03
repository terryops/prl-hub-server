// Google Play purchases of Pro (play.js): POST /v1/purchase/google, refunds, acknowledgements.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupAccount, request, login } from "./account-fixture.js";
import { setNow, restoreNow, T0 } from "./helpers.js";
import { random } from "../src/auth.js";
import { sha256 } from "../src/http.js";
import { playHousekeeping, resetPlayToken, PLAY_PRODUCT } from "../src/play.js";
import worker from "../src/index.js";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.prl.wizard";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REG = "dRk9Q3v_T0m:APA91bH" + "x".repeat(140);

const rsa = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", rsa.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const SA = JSON.stringify({ type: "service_account", project_id: "pearl-test", private_key_id: "k1", private_key: PEM,
  client_email: "play-verifier@pearl-test.iam.gserviceaccount.com", token_uri: TOKEN_URL });

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; restoreNow(); resetPlayToken(); });

const token = (n) => `ab${n}`.padEnd(40, "c") + ".AO-J1Oz" + "x".repeat(60);
const bought = (extra = {}) => ({ kind: "androidpublisher#productPurchase", purchaseTimeMillis: String((T0 - 60) * 1000),
  purchaseState: 0, consumptionState: 0, orderId: "GPA.3300-1111-2222-33333", acknowledgementState: 0, regionCode: "US", ...extra });

/// An account fixture whose Google answers from `g.purchases[token]` (404 when missing), counts
/// acknowledgements, and lists `g.voided`. Every other host but Turnstile is unreachable.
function fixture(extra = {}) {
  setNow(T0);
  const f = setupAccount({ PLAY_SERVICE_ACCOUNT: SA, FCM_SERVICE_ACCOUNT: SA, ...extra }), turnstile = globalThis.fetch;
  const g = f.google = { purchases: {}, gets: [], acks: [], ackStatus: () => 204, getStatus: () => null, voided: [], voidedQueries: [], tokens: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "challenges.cloudflare.com") return turnstile(url, init);
    if (String(url) === TOKEN_URL) {
      g.tokens++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      assert.equal(JSON.parse(Buffer.from(form.get("assertion").split(".")[1], "base64url")).scope, "https://www.googleapis.com/auth/androidpublisher");
      return Response.json({ access_token: `at-${g.tokens}`, expires_in: 3600 });
    }
    if (String(url).startsWith(API)) {
      assert.match(init.headers.authorization, /^Bearer at-\d+$/);
      const path = String(url).slice(API.length);
      const m = path.match(/^\/purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:acknowledge)?$/);
      if (m && m[3]) { g.acks.push(decodeURIComponent(m[2])); const s = g.ackStatus(); return new Response(s === 204 ? null : "{}", { status: s }); }
      if (m) {
        g.gets.push(decodeURIComponent(m[2]));
        const forced = g.getStatus();
        if (forced) return Response.json({ error: { message: "forced" } }, { status: forced });
        const p = m[1] === PLAY_PRODUCT && g.purchases[decodeURIComponent(m[2])];
        return p ? Response.json(p) : Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
      }
      if (path.startsWith("/purchases/voidedpurchases?")) {
        const q = new URL(String(url)).searchParams;
        g.voidedQueries.push(Object.fromEntries(q));
        const pages = g.voided, i = Number(q.get("token") || 0);
        return Response.json({ voidedPurchases: pages[i] || [], ...(i + 1 < pages.length ? { tokenPagination: { nextPageToken: String(i + 1) } } : {}) });
      }
    }
    return new Response("unreachable in tests", { status: 503 });
  };
  return f;
}
async function visitor(f) {
  const r = await request(f.env, "POST", "/v1/purchase/session", { device_id: random(24) });
  assert.equal(r.status, 200);
  return { id: r.data.purchase_id, key: r.data.purchase_key, headers: { "X-Purchase-Key": r.data.purchase_key, "X-Account-ID": r.data.purchase_id } };
}
const buy = (f, tok, headers, product = PLAY_PRODUCT) => request(f.env, "POST", "/v1/purchase/google", { product_id: product, purchase_token: tok }, headers);
const me = async (f, headers) => (await request(f.env, "GET", "/v1/me", undefined, headers)).data;
const ref = (tok) => sha256(`play:${tok}`);

test("play: a guest's purchase unlocks Pro on that device, is acknowledged once, and is not asked of Play again", async () => {
  const f = fixture(), v = await visitor(f), tok = token(1);
  f.google.purchases[tok] = bought();
  const r = await buy(f, tok, v.headers);
  assert.equal(r.status, 200);
  assert.equal(r.data.pro, true);
  assert.equal(r.data.pro_scope, "device");
  assert.deepEqual(f.google.acks, [tok]);
  const row = f.env.DB.one("SELECT * FROM google_purchases");
  assert.equal(row.ref, await ref(tok));
  assert.equal(row.order_id, "GPA.3300-1111-2222-33333");
  assert.equal(row.acknowledged_at, T0);
  assert.equal(row.purchased_at, T0 - 60);
  assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='google'").user_id, v.id);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM purchase_licenses WHERE visitor_id=? AND source='google'", v.id).n, 1);
  // Again (the app syncs owned purchases at start): no second verify or acknowledgement.
  assert.equal((await buy(f, tok, v.headers)).status, 200);
  assert.equal(f.google.gets.length, 1);
  assert.equal(f.google.acks.length, 1);
  assert.equal((await me(f, v.headers)).pro, true);
  // An already acknowledged purchase (acknowledged elsewhere) is not acknowledged again.
  const v2 = await visitor(f), tok2 = token(2);
  f.google.purchases[tok2] = bought({ acknowledgementState: 1, orderId: "GPA.2" });
  assert.equal((await buy(f, tok2, v2.headers)).status, 200);
  assert.deepEqual(f.google.acks, [tok]);
});

test("play: a pending purchase answers 202 and grants nothing until Play says purchased", async () => {
  const f = fixture(), v = await visitor(f), tok = token(3);
  f.google.purchases[tok] = bought({ purchaseState: 2 });
  const r = await buy(f, tok, v.headers);
  assert.equal(r.status, 202);
  assert.deepEqual(r.data, { pending: true });
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM google_purchases").n, 0);
  assert.equal((await me(f, v.headers)).pro, false);
  f.google.purchases[tok] = bought();
  assert.equal((await buy(f, tok, v.headers)).data.pro, true);
});

test("play: refused purchases, test purchases, missing credentials and a missing service account", async () => {
  const f = fixture(), v = await visitor(f);
  f.google.purchases[token(4)] = bought({ purchaseState: 1 });
  f.google.purchases[token(5)] = bought({ purchaseType: 0 });
  const unknown = await buy(f, token(9), v.headers);
  assert.deepEqual([unknown.status, unknown.data], [400, { error: "bad_receipt" }]);
  assert.equal((await buy(f, token(4), v.headers)).status, 400);
  assert.equal((await buy(f, token(1), v.headers, "com.prl.wizard.other")).status, 400);
  assert.equal((await buy(f, "short", v.headers)).status, 400);
  assert.equal((await buy(f, token(5), v.headers)).status, 400, "a license tester's purchase needs PLAY_TEST_OK");
  assert.equal((await buy(f, token(1), {})).status, 401);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM google_purchases").n, 0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n, 0);

  const t = fixture({ PLAY_TEST_OK: "1" }), tv = await visitor(t);
  t.google.purchases[token(5)] = bought({ purchaseType: 0 });
  assert.equal((await buy(t, token(5), tv.headers)).data.pro, true);
  assert.equal(t.env.DB.one("SELECT test FROM google_purchases").test, 1);

  const off = fixture({ PLAY_SERVICE_ACCOUNT: undefined }), ov = await visitor(off);
  assert.deepEqual((await buy(off, token(1), ov.headers)).data, { error: "play_off" });
  const status = async (env) => (await (await worker.fetch(new Request("https://prl.test/v1/web/status"), env, {})).json()).play;
  assert.equal(await status(off.env), false);
  assert.equal(await status(f.env), true);
});

test("play: Play refusing the service account or failing is 503 and records nothing", async () => {
  const f = fixture(), v = await visitor(f), tok = token(6);
  f.google.purchases[tok] = bought();
  f.google.getStatus = () => 403;
  assert.deepEqual((await buy(f, tok, v.headers)).data, { error: "play_unavailable" });
  f.google.getStatus = () => 500;
  assert.equal((await buy(f, tok, v.headers)).status, 503);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM google_purchases").n, 0);
  f.google.getStatus = () => null;
  assert.equal((await buy(f, tok, v.headers)).data.pro, true);
});

test("play: signed in, the purchase is the account's; another account gets 409; a new install restores it", async () => {
  const f = fixture(), v = await visitor(f), a = await login(f), tok = token(7);
  f.google.purchases[tok] = bought();
  const both = { ...a.credentials, "X-Purchase-Key": v.key, "X-Account-ID": a.user_id };
  const r = await buy(f, tok, both);
  assert.equal(r.status, 200);
  assert.equal(r.data.pro, true);
  assert.equal(r.data.pro_scope, "account");
  assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='google'").user_id, a.user_id);
  const rights = await request(f.env, "GET", "/v1/account/entitlements", undefined, a.credentials);
  assert.deepEqual(rights.data.entitlements.map((e) => [e.source, e.revoked_at]), [["google", null]]);
  // Account alone (no device credential) works too.
  assert.equal((await me(f, { ...a.credentials, "X-Account-ID": a.user_id })).pro, true);

  const b = await login(f, "second@163.com");
  const other = await buy(f, tok, { ...b.credentials, "X-Account-ID": b.user_id });
  assert.deepEqual([other.status, other.data], [409, { error: "purchase_already_linked" }]);
  assert.equal((await me(f, { ...b.credentials, "X-Account-ID": b.user_id })).pro, false);

  // The same Google account on a reinstalled phone, not signed in: that device is licensed.
  const v2 = await visitor(f);
  const restored = await buy(f, tok, v2.headers);
  assert.equal(restored.data.pro, true);
  assert.equal(restored.data.pro_scope, "device");
  assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='google'").user_id, a.user_id, "still the account's");
  assert.equal(f.google.gets.length, 1);
});

test("play: a purchase made before signing in moves to the account when the device signs in", async () => {
  const f = fixture(), v = await visitor(f), tok = token(8);
  f.google.purchases[tok] = bought();
  assert.equal((await buy(f, tok, v.headers)).data.pro_scope, "device");
  const a = await login(f);
  const linked = await request(f.env, "POST", "/v1/purchase/associate", {}, { ...a.credentials, "X-Purchase-Key": v.key });
  assert.equal(linked.status, 200);
  assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='google'").user_id, a.user_id);
  const m = await me(f, { ...a.credentials, "X-Purchase-Key": v.key, "X-Account-ID": a.user_id });
  assert.equal(m.pro, true);
  assert.equal(m.pro_scope, "account");
  // Presenting it again while signed in changes nothing.
  assert.equal((await buy(f, tok, { ...a.credentials, "X-Purchase-Key": v.key, "X-Account-ID": a.user_id })).status, 200);
  // Once it is an account's, another account still cannot take it.
  const b = await login(f, "second@163.com");
  assert.equal((await buy(f, tok, { ...b.credentials, "X-Account-ID": b.user_id })).status, 409);
});

test("play: an acknowledgement that failed at purchase time is retried hourly for three days", async () => {
  const f = fixture(), v = await visitor(f), tok = token(10);
  f.google.purchases[tok] = bought();
  f.google.ackStatus = () => 500;
  assert.equal((await buy(f, tok, v.headers)).data.pro, true, "Pro does not wait for the acknowledgement");
  assert.equal(f.env.DB.one("SELECT acknowledged_at FROM google_purchases").acknowledged_at, null);
  f.google.ackStatus = () => 204;
  setNow(T0 + 3600);
  await playHousekeeping(f.env);
  assert.deepEqual(f.google.acks, [tok, tok]);
  assert.equal(f.env.DB.one("SELECT acknowledged_at FROM google_purchases").acknowledged_at, T0 + 3600);
  await playHousekeeping(f.env);
  assert.equal(f.google.acks.length, 2);
  // Past three days Play has refunded it anyway: no more attempts.
  const g = fixture(), gv = await visitor(g), late = token(11);
  g.google.purchases[late] = bought();
  g.google.ackStatus = () => 500;
  await buy(g, late, gv.headers);
  setNow(T0 + 3 * 86400 + 60);
  await playHousekeeping(g.env);
  assert.equal(g.google.acks.length, 1);
});

test("play: a voided purchase ends Pro for the account and every licensed device and drops their Android push", async () => {
  const f = fixture(), v = await visitor(f), a = await login(f), tok = token(12);
  f.google.purchases[tok] = bought();
  await buy(f, tok, { ...a.credentials, "X-Purchase-Key": v.key, "X-Account-ID": a.user_id });
  const v2 = await visitor(f);
  await buy(f, tok, v2.headers);
  // The guest device registers its Android push (FCM) under its purchase credential.
  const push = await request(f.env, "PUT", "/v1/web/push", { fcm: { token: REG }, lang: "en", rules: [{ id: "r", kind: "above", value: 2, window: 0, enabled: true }] }, v2.headers);
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices WHERE chan='fcm'").n, 1);

  f.google.voided = [[{ purchaseToken: "unknown-token", orderId: "GPA.x" }], [{ purchaseToken: tok, orderId: "GPA.3300-1111-2222-33333", voidedTimeMillis: String(T0 * 1000) }]];
  setNow(T0 + 3600);
  await playHousekeeping(f.env);
  assert.equal(f.google.voidedQueries.length, 2, "follows the page token");
  assert.equal(Number(f.google.voidedQueries[0].startTime), (T0 + 3600 - 30 * 86400 + 60) * 1000, "first look: 30 days back");
  assert.equal(f.google.voidedQueries[0].type, "0");
  assert.equal(f.env.DB.one("SELECT revoked_at FROM google_purchases").revoked_at, T0 + 3600);
  assert.equal(f.env.DB.one("SELECT revoked_at FROM entitlements WHERE source='google'").revoked_at, T0 + 3600);
  assert.equal((await me(f, { ...a.credentials, "X-Account-ID": a.user_id })).pro, false);
  assert.equal((await me(f, v2.headers)).pro, false);
  assert.equal((await me(f, v.headers)).pro, false);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices WHERE chan='fcm'").n, 0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM fcm").n, 0);
  assert.equal((await buy(f, tok, v2.headers)).status, 400, "a voided token never unlocks again");

  // The next look starts an hour before the last one.
  f.google.voided = [];
  setNow(T0 + 7200);
  await playHousekeeping(f.env);
  assert.equal(Number(f.google.voidedQueries.at(-1).startTime), (T0 + 3600 - 3600) * 1000);
});

test("play: the hourly cron runs the housekeeping; without the secret it asks Play nothing", async () => {
  const f = fixture();
  setNow(T0 + 3600);
  await worker.scheduled({}, f.env);
  assert.equal(f.google.voidedQueries.length, 1);
  setNow(T0 + 3660);
  await worker.scheduled({}, f.env);
  assert.equal(f.google.voidedQueries.length, 1, "only on the hour");
  const off = fixture({ PLAY_SERVICE_ACCOUNT: undefined });
  setNow(T0 + 3600);
  await worker.scheduled({}, off.env);
  assert.equal(off.google.voidedQueries.length, 0);
  assert.equal(off.google.tokens, 0);
});
