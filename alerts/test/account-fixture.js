import worker from "../src/index.js";
import { makeEnv, T0 } from "./helpers.js";
import { random } from "../src/auth.js";
import { sha256 } from "../src/http.js";

// Explicit authenticated fixtures for older payment/push regressions. New security
// tests use real email verification below and never auto-authorize input tokens.
export async function seedSession(env, token, uid = null, did = "fixture-device-0001") {
  const hash = await sha256(token);
  const user = uid || hash, sid = `fixture-${hash}`;
  env.DB.raw.prepare("INSERT OR IGNORE INTO users(id,email,created_at) VALUES(?,?,?)").run(user, `${hash}@fixture.test`, T0);
  env.DB.raw.prepare("INSERT OR IGNORE INTO account_devices(id,user_id,name,platform,created_at,seen_at) VALUES(?,?,'Fixture','web',?,?)").run(did, user, T0, T0);
  env.DB.raw.prepare(`INSERT OR IGNORE INTO sessions(id,user_id,device_id,client,access_hash,created_at,seen_at,access_expires,idle_expires,max_expires,email_verified_at)
    VALUES(?,?,?,'native',?,?,?,?,?,?,?)`).run(sid, user, did, hash, T0, T0, T0+90*86400, T0+90*86400, T0+90*86400, T0);
  return user;
}
export function setupAccount(extra = {}, hooks = {}) {
  const emails = [], used = new Set();
  const env = makeEnv({ ACCOUNT_ENABLED: "1", AUTH_PEPPER: "isolated-test-pepper", ACCOUNT_CONFIG_KEY: Buffer.alloc(32, 7).toString("base64"),
    TURNSTILE_SITE_KEY: "fixture-site", TURNSTILE_SECRET: "fixture-secret", EMAIL_FROM: "login@fixture.test", EMAIL_DAILY_LIMIT: "100",
    EMAIL: { send: async (message) => { emails.push(message); return { messageId: random(12) }; } }, ...extra }, hooks);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const body = JSON.parse(init.body), token = body.response;
      const success = typeof token === "string" && token.startsWith("human-") && !used.has(token);
      used.add(token);
      return Response.json({ success, hostname: "prl.test", action: token?.split(":")[1] || "email_login" });
    }
    return previous(url, init);
  };
  return { env, emails };
}
export async function request(env, method, path, body, credentials = {}) {
  const res = await worker.fetch(new Request(`https://prl.test${path}`, {
    method, headers: { "content-type": "application/json", origin: "https://prl.test", ...credentials },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {});
  const data = await res.json();
  return { status: res.status, data, headers: res.headers };
}
export async function challenge(fixture, email = "person@qq.com", purpose = "login", credentials = {}) {
  const r = await request(fixture.env, "POST", "/v1/auth/email/start", { email, purpose, lang: "zh-Hans", turnstile: `human-${random(8)}:email_${purpose}` }, credentials);
  const mail = fixture.emails.at(-1);
  return { response: r, challenge_id: r.data.challenge_id, code: mail?.text.match(/\b\d{6}\b/)?.[0] };
}
export async function login(fixture, email = "person@qq.com", device = random(24)) {
  const proof = await challenge(fixture, email);
  if (proof.response.status !== 200) throw new Error(`fixture login start: ${proof.response.status}`);
  const r = await request(fixture.env, "POST", "/v1/auth/email/verify", { challenge_id: proof.challenge_id, code: proof.code, device_id: device, device_name: "Browser", platform: "web" });
  if (r.status !== 200) throw new Error(`fixture login verify: ${r.status}`);
  return { ...r.data, cookie: r.headers.get("set-cookie").split(";")[0], credentials: { cookie: r.headers.get("set-cookie").split(";")[0] }, proof };
}
export const configFixture = () => ({ lang: "en", settingsUpdated: Date.now(), monitors: [], wallets: [], rules: [], window: null, contacts: [], devices: [] });
