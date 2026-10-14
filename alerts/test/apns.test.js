import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { send, BACKOFF_429, resetTokenCache } from "../src/apns.js";
import { makeEnv, installFetch, setNow, restoreNow, T0, tok } from "./helpers.js";

afterEach(restoreNow);

const device = (i) => ({ token: tok(i), env: "production", topic: "com.prl.wizard" });
const pushAll = (env, n) => Promise.all(Array.from({ length: n }, (_, i) => send(env, env.DB, device(i), { aps: {} })));
const jwtWrites = (env) => env.DB.log.filter((s) => s.startsWith("INSERT OR REPLACE INTO kv") && s.includes("apns_jwt")).length;

test("apns (#4): concurrent pushes at a cold start share one provider token", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  const res = await pushAll(env, 10);
  assert.ok(res.every((r) => r.ok));
  assert.equal(new Set(net.calls.map((c) => c.headers.authorization)).size, 1);
  assert.equal(jwtWrites(env), 1);
  // Another isolate (fresh memory) picks the shared token up from D1.
  resetTokenCache();
  assert.ok((await pushAll(env, 3)).every((r) => r.ok));
  assert.equal(new Set(net.calls.map((c) => c.headers.authorization)).size, 1);
  assert.equal(jwtWrites(env), 1);
});

test("apns (#4): a burst of ExpiredProviderToken refreshes the token once", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await pushAll(env, 1);
  const first = net.calls[0].headers.authorization;
  net.apns = (c) => (c.headers.authorization === first ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 });
  setNow(T0 + 1200);                       // Apple's 20-min minimum between refreshes has passed
  const res = await pushAll(env, 10);
  assert.ok(res.every((r) => r.ok));
  assert.equal(new Set(net.calls.map((c) => c.headers.authorization)).size, 2);
  assert.equal(jwtWrites(env), 2);
});

test("apns (#1): a failed D1 write of the token doesn't fail the push", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv({}, { before: (sql) => { if (sql.includes("'apns_jwt'")) throw new Error("D1_ERROR"); } });
  assert.deepEqual(await send(env, env.DB, device(1), { aps: {} }), { ok: true, env: "production" });
});

test("apns (#8): verdicts", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  const one = async (status, reason) => {
    net.apns = () => ({ status, reason });
    const r = await send(env, env.DB, device(1), { aps: {} });
    return Object.keys(r).filter((k) => r[k] === true)[0] + (r.backoff ? `+${r.backoff}` : "");
  };
  assert.equal(await one(200), "ok");
  assert.equal(await one(410, "Unregistered"), "drop");
  assert.equal(await one(400, "DeviceTokenNotForTopic"), "drop");
  assert.equal(await one(400, "BadDeviceToken"), "drop");          // on both hosts
  assert.equal(await one(400, "BadTopic"), "fail");
  assert.equal(await one(413, "PayloadTooLarge"), "fail");
  assert.equal(await one(403, "BadCertificateEnvironment"), "fail");
  assert.equal(await one(429, "TooManyRequests"), `retry+${BACKOFF_429}`);
  assert.equal(await one(500, "InternalServerError"), "retry");
  assert.equal(await one(503, "ServiceUnavailable"), "retry");
  net.apns = () => Promise.reject(new Error("The operation was aborted due to timeout"));
  const r = await send(env, env.DB, device(1), { aps: {} });
  assert.equal(r.retry, true);
  assert.equal(r.status, 0);
});
