import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { setupAccount } from "./account-fixture.js";
import { random } from "../src/auth.js";
import { restoreNow } from "./helpers.js";

// Exercise the same checks against the frozen production bundle before release.
const { default: worker } = await import(process.env.PRL_DOMAIN_WORKER
  ? pathToFileURL(process.env.PRL_DOMAIN_WORKER).href : "../src/index.js");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; restoreNow(); });

const origins = ["https://pearlhub.net", "https://www.pearlhub.net", "https://prl.tools.video"];
function fixture(origin, verifiedHostname = new URL(origin).hostname) {
  const f = setupAccount({ ACCOUNT_ORIGIN: "" });
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    return Response.json({ success: true, hostname: verifiedHostname, action: "email_login" });
  };
  return f;
}
async function request(f, origin, path, body, headers = {}) {
  const response = await worker.fetch(new Request(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  }), f.env, {});
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const loginBody = () => ({ email: "domain-test@example.test", turnstile: "fixture-token", lang: "en" });

for (const origin of origins) {
  test(`domain migration: login, cookie session and purchase session work on ${origin}`, async () => {
    const f = fixture(origin);
    const start = await request(f, origin, "/v1/auth/email/start", loginBody());
    assert.equal(start.status, 200);
    assert.equal(f.emails.length, 1);
    assert.ok(f.emails[0].text.includes("https://pearlhub.net/"));
    assert.ok(f.emails[0].html.includes('href="https://pearlhub.net/?account=manage"'));
    assert.ok(!f.emails[0].html.includes("prl.tools.video"));
    const code = f.emails[0].text.match(/\b\d{6}\b/)[0];
    const verify = await request(f, origin, "/v1/auth/email/verify", {
      challenge_id: start.data.challenge_id, code, device_id: random(24), platform: "web", device_name: "Domain test",
    });
    assert.equal(verify.status, 200);
    const cookie = verify.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^__Host-prl_session=/);
    const otherOrigin = origins.find((other) => other !== origin);
    const denied = await request(f, origin, "/v1/auth/logout", {}, { cookie, origin: otherOrigin });
    assert.equal(denied.status, 401);
    const logout = await request(f, origin, "/v1/auth/logout", {}, { cookie });
    assert.equal(logout.status, 200);
    const purchase = await request(f, origin, "/v1/purchase/session", { device_id: random(24) });
    assert.equal(purchase.status, 200);
    assert.ok(purchase.data.purchase_key);
    const crossPurchase = await request(f, origin, "/v1/purchase/session", { device_id: random(24) }, { origin: otherOrigin });
    assert.equal(crossPurchase.status, 403);
  });
}

test("domain migration: another domain's Turnstile proof cannot sign in on the new domain", async () => {
  const f = fixture(origins[0], "prl.tools.video");
  const response = await request(f, origins[0], "/v1/auth/email/start", loginBody());
  assert.equal(response.status, 403);
  assert.equal(response.data.error, "human_verification_failed");
  assert.equal(f.emails.length, 0);
});

test("domain migration: untrusted Origin cannot trigger a verification email", async () => {
  const f = fixture(origins[0]);
  const response = await request(f, origins[0], "/v1/auth/email/start", loginBody(), { origin: "https://attacker.example" });
  assert.equal(response.status, 403);
  assert.equal(response.data.error, "bad_origin");
  assert.equal(f.emails.length, 0);
});
