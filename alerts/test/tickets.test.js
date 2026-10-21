// Sign in once, on every device: device tickets (POST /v1/account/ticket, POST /v1/auth/ticket).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setNow, restoreNow, T0 } from "./helpers.js";
import { setupAccount, request, login, challenge } from "./account-fixture.js";
import { random } from "../src/auth.js";
import { sha256 } from "../src/http.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; restoreNow(); });
const REDIRECT = "prlhub://account";
const boot = () => { setNow(T0); return setupAccount({ ACCOUNT_REDIRECTS: REDIRECT }); };
const bearer = (s) => ({ Authorization: `Bearer ${s.access_token}` });

/// A native app signed in the usual way: the browser authorizes, the app exchanges.
async function nativeLogin(f, browser, platform = "ios", device = random(24)) {
  const verifier = random();
  const challengeHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const grant = await request(f.env, "POST", "/v1/auth/authorize",
    { redirect_uri: REDIRECT, code_challenge: challengeHash, device_id: device, platform, device_name: "iPhone" }, browser.credentials);
  assert.equal(grant.status, 200);
  const out = await request(f.env, "POST", "/v1/auth/exchange", { code: grant.data.code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(out.status, 200);
  return out.data;
}
const issue = (f, s) => request(f.env, "POST", "/v1/account/ticket", {}, bearer(s));
const redeem = (f, ticket, device = random(24), platform = "macos") =>
  request(f.env, "POST", "/v1/auth/ticket", { ticket, device_id: device, platform, device_name: "Mac" });

test("tickets: another device signs itself in with its own session, never a fresh email check", async () => {
  const f = boot(), browser = await login(f), phone = await nativeLogin(f, browser);
  const t = await issue(f, phone);
  assert.equal(t.status, 200);
  assert.equal(t.data.expires_in, 30 * 86400);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM device_tickets WHERE hash=?", await sha256(t.data.ticket)).n, 1);

  const macDevice = random(24), mac = await redeem(f, t.data.ticket, macDevice);
  assert.equal(mac.status, 200);
  assert.equal(mac.data.user_id, phone.user_id);
  assert.equal(mac.data.device_id, macDevice);
  assert.notEqual(mac.data.refresh_token, phone.refresh_token);
  const me = await request(f.env, "GET", "/v1/account", undefined, bearer(mac.data));
  assert.equal(me.status, 200);
  assert.equal(me.data.email, "person@qq.com");
  // The phone keeps its own session, and the Mac shows up as a device of its own.
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, bearer(phone))).status, 200);
  const devices = (await request(f.env, "GET", "/v1/account/devices", undefined, bearer(phone))).data.devices;
  assert.deepEqual(devices.map((d) => d.platform).sort(), ["ios", "macos", "web"]);
  const s = f.env.DB.one("SELECT email_verified_at, client FROM sessions WHERE access_hash=?", await sha256(mac.data.access_token));
  assert.equal(s.email_verified_at, 0);
  assert.equal(s.client, "native");

  // Multi-use: an iPad on the same iCloud Keychain gets in the same way.
  assert.equal((await redeem(f, t.data.ticket, random(24), "ios")).status, 200);
});

test("tickets: the issuing installation can't trade its own ticket", async () => {
  const f = boot(), browser = await login(f), device = random(24), phone = await nativeLogin(f, browser, "ios", device);
  const t = await issue(f, phone);
  const own = await redeem(f, t.data.ticket, device, "ios");
  assert.equal(own.status, 401);
  assert.equal(own.data.error, "invalid_ticket");
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, bearer(phone))).status, 200);
});

test("tickets: dead once the issuing session ends — sign-out, removal from another device, re-login", async () => {
  {
    const f = boot(), browser = await login(f), phone = await nativeLogin(f, browser), t = await issue(f, phone);
    assert.equal((await request(f.env, "POST", "/v1/auth/logout", {}, bearer(phone))).status, 200);
    assert.equal((await redeem(f, t.data.ticket)).status, 401);
  }
  {
    const f = boot(), browser = await login(f), phone = await nativeLogin(f, browser), t = await issue(f, phone);
    assert.equal((await request(f.env, "DELETE", `/v1/account/devices/${phone.device_id}`, undefined, browser.credentials)).status, 200);
    assert.equal((await redeem(f, t.data.ticket)).status, 401);
  }
  {
    // Signing in again on the same phone replaces its session, and with it the old ticket.
    const f = boot(), browser = await login(f), phone = await nativeLogin(f, browser), t = await issue(f, phone);
    await nativeLogin(f, browser, "ios", phone.device_id);
    assert.equal((await redeem(f, t.data.ticket)).status, 401);
  }
});

test("tickets: a refreshed ticket replaces the last; expired tickets are refused", async () => {
  const f = boot(), browser = await login(f), phone = await nativeLogin(f, browser);
  const first = await issue(f, phone), second = await issue(f, phone);
  assert.notEqual(first.data.ticket, second.data.ticket);
  assert.equal((await redeem(f, first.data.ticket)).status, 401);
  assert.equal((await redeem(f, second.data.ticket)).status, 200);

  // Keep the phone's session alive (seen within its idle window) past the ticket's lifetime.
  for (let day = 10; day <= 30; day += 10) {
    setNow(T0 + day * 86400);
    const r = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: phone.refresh_token });
    assert.equal(r.status, 200);
    Object.assign(phone, r.data);
  }
  setNow(T0 + 30 * 86400 + 1);
  assert.equal((await redeem(f, second.data.ticket)).status, 401);
  assert.equal((await redeem(f, (await issue(f, phone)).data.ticket)).status, 200);
});

test("tickets: only signed-in iOS / macOS apps issue them; malformed requests are refused", async () => {
  const f = boot(), browser = await login(f);
  assert.equal((await request(f.env, "POST", "/v1/account/ticket", {}, browser.credentials)).status, 403);
  const extension = await nativeLogin(f, browser, "extension");
  assert.equal((await issue(f, extension)).status, 403);
  assert.equal((await request(f.env, "POST", "/v1/account/ticket", {})).status, 401);
  const phone = await nativeLogin(f, browser), t = await issue(f, phone);
  assert.equal((await redeem(f, random())).status, 401);
  assert.equal((await redeem(f, "short")).status, 400);
  assert.equal((await redeem(f, t.data.ticket, "bad id")).status, 400);
  assert.equal((await redeem(f, t.data.ticket, random(24), "web")).status, 400);
  assert.equal((await redeem(f, t.data.ticket, random(24), "android")).status, 400);
});

test("tickets: deleting the account removes them", async () => {
  const f = boot(), browser = await login(f), phone = await nativeLogin(f, browser), t = await issue(f, phone);
  setNow(T0 + 60);   // past the one-minute resend cooldown of the login code
  const proof = await challenge(f, "person@qq.com", "delete", browser.credentials);
  const del = await request(f.env, "DELETE", "/v1/account", { challenge_id: proof.challenge_id, code: proof.code }, browser.credentials);
  assert.equal(del.status, 200);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM device_tickets").n, 0);
  assert.equal((await redeem(f, t.data.ticket)).status, 401);
});
