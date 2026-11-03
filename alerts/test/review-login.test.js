// REVIEW_LOGIN: a fixed login code for one address, for Google Play's reviewers (see auth.js reviewCode).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setNow, restoreNow, T0 } from "./helpers.js";
import { setupAccount, request, challenge } from "./account-fixture.js";
import { random } from "../src/auth.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; restoreNow(); });
const EMAIL = "play-review@pearlhub.net", CODE = "418277";
const boot = (extra = { REVIEW_LOGIN: JSON.stringify({ email: EMAIL, code: CODE }) }) => { setNow(T0); return setupAccount(extra); };
const verify = (f, challenge_id, code, device_id = random(24)) =>
  request(f.env, "POST", "/v1/auth/email/verify", { challenge_id, code, device_id, device_name: "Pixel", platform: "android" });

test("review login: the review address signs in with the fixed code and no email is sent", async () => {
  const f = boot();
  const start = await request(f.env, "POST", "/v1/auth/email/start", { email: " Play-Review@PearlHub.net ", lang: "en", turnstile: `human-${random(8)}:email_login` });
  assert.equal(start.status, 200);
  assert.deepEqual(Object.keys(start.data).sort(), ["challenge_id", "expires_in", "resend_after"]);
  assert.equal(f.emails.length, 0);
  assert.equal(f.env.DB.one("SELECT delivered FROM auth_challenges WHERE id=?", start.data.challenge_id).delivered, 1);
  const r = await verify(f, start.data.challenge_id, CODE);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /__Host-prl_session=/);
  assert.equal(f.env.DB.one("SELECT email FROM users WHERE id=?", r.data.user_id).email, EMAIL);
});

test("review login: wrong codes count toward the 5-attempt limit, expiry still applies", async () => {
  const f = boot();
  let c = await challenge(f, EMAIL);
  for (let i = 0; i < 5; i++) assert.equal((await verify(f, c.challenge_id, "000000")).status, 401);
  assert.equal((await verify(f, c.challenge_id, CODE)).status, 401, "locked after 5 attempts");
  setNow(T0 + 120); c = await challenge(f, EMAIL);
  setNow(T0 + 120 + 301);
  assert.equal((await verify(f, c.challenge_id, CODE)).status, 401, "expired");
});

test("review login: Turnstile, the per-address cooldown and the origin check still apply", async () => {
  const f = boot();
  assert.equal((await request(f.env, "POST", "/v1/auth/email/start", { email: EMAIL, turnstile: "robot" })).status, 403);
  assert.equal((await request(f.env, "POST", "/v1/auth/email/start", { email: EMAIL, turnstile: `human-${random(8)}:email_login` }, { origin: "https://attacker.test" })).status, 403);
  assert.equal((await challenge(f, EMAIL)).response.status, 200);
  assert.equal((await challenge(f, EMAIL)).response.status, 429);
});

test("review login: other addresses and other purposes still get an emailed random code", async () => {
  const f = boot();
  const other = await challenge(f, "person@qq.com");
  assert.equal(f.emails.length, 1);
  assert.equal((await verify(f, other.challenge_id, CODE === other.code ? "000000" : CODE)).status, 401);
  assert.equal((await verify(f, other.challenge_id, other.code)).status, 200);
  // Signed in as the review account, deleting it still needs an emailed code, not the fixed one.
  const start = await challenge(f, EMAIL), session = await verify(f, start.challenge_id, CODE);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  setNow(T0 + 61);
  const del = await challenge(f, EMAIL, "delete", { cookie });
  assert.equal(del.response.status, 200);
  assert.equal(f.emails.length, 2);
  assert.equal(f.emails.at(-1).to, EMAIL);
});

test("review login: unset or malformed REVIEW_LOGIN leaves sign-in unchanged", async () => {
  for (const extra of [{}, { REVIEW_LOGIN: "not json" }, { REVIEW_LOGIN: JSON.stringify({ email: EMAIL, code: "12345" }) },
    { REVIEW_LOGIN: JSON.stringify({ email: EMAIL, code: 418277 }) }, { REVIEW_LOGIN: JSON.stringify({ code: CODE }) }]) {
    const f = boot(extra);
    const c = await challenge(f, EMAIL);
    assert.equal(c.response.status, 200);
    assert.equal(f.emails.length, 1, JSON.stringify(extra));
    if (c.code !== CODE) assert.equal((await verify(f, c.challenge_id, CODE)).status, 401);
    assert.equal((await verify(f, c.challenge_id, c.code)).status, 200);
  }
});

test("review login: the release's D1 setup (user row + admin Pro grant) gives the review account Pro", async () => {
  const f = boot(), uid = "u_playreview" + "x".repeat(20);
  // Same statements as play-review-release/d1-review-account.sql, with T0 for the timestamps.
  f.env.DB.raw.prepare("INSERT INTO users(id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").run(uid, EMAIL, T0);
  f.env.DB.raw.prepare("INSERT OR IGNORE INTO account_configs(user_id) VALUES (?)").run(uid);
  f.env.DB.raw.prepare(`INSERT INTO groups (gid, created_at, seen_at, pro_at, pro_src, pro_ref) VALUES (?, ?, ?, ?, 'admin', 'play-review')
    ON CONFLICT(gid) DO UPDATE SET pro_at = COALESCE(groups.pro_at, excluded.pro_at), pro_src = 'admin', pro_ref = excluded.pro_ref`).run(uid, T0, T0, T0);
  const c = await challenge(f, EMAIL), r = await verify(f, c.challenge_id, CODE);
  assert.equal(r.status, 200);
  assert.equal(r.data.user_id, uid);
  const me = await request(f.env, "GET", "/v1/me", undefined, { cookie: r.headers.get("set-cookie").split(";")[0] });
  assert.equal(me.status, 200);
  assert.equal(me.data.pro, true);
  assert.equal(f.env.DB.one("SELECT source FROM entitlements WHERE user_id=?", uid).source, "admin");
});
