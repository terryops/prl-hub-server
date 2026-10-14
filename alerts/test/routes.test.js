import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeEnv, installFetch, setNow, restoreNow, T0, tok, liveTok, call, register, tick, makeChain, signJWS, proTx } from "./helpers.js";

afterEach(restoreNow);

const above = (id = "r", value = 0.5) => ({ id, kind: "above", value });
const devices = (env) => env.DB.rows("SELECT token, env, verified_at, original_transaction_id AS otid FROM devices");

test("devices: validation", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const put = (token, body) => call(env, "PUT", `/v1/devices/${token}`, body);
  const ok = { env: "production", topic: "com.prl.wizard", rules: [above()] };
  assert.equal((await put("xyz", ok)).status, 400);
  assert.equal((await put(tok(1), { ...ok, topic: "com.evil" })).status, 400);
  assert.equal((await put(tok(1), { ...ok, env: "dev" })).status, 400);
  assert.equal((await put(tok(1), { ...ok, rules: Array.from({ length: 21 }, (_, i) => above(`r${i}`)) })).status, 400);
  assert.equal((await put(tok(1), { ...ok, rules: [above(), above()] })).status, 400);
  assert.equal((await put(tok(1), { ...ok, rules: [{ id: "r", kind: "above", value: "1" }] })).status, 400);
  assert.equal((await put(tok(1), "{nope")).status, 400);
  assert.equal(devices(env).length, 0);
  const res = await put(tok(1), ok);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rules.map((r) => [r.id, r.enabled, r.armed]), [["r", true, true]]);
  assert.equal((await put(tok(1), { ...ok, rules: [] })).status, 200);   // no rules = forget the device
  assert.equal(devices(env).length, 0);
  assert.equal((await call(env, "GET", "/v1/nope")).status, 404);
});

test("devices (#10): the body cap holds without a Content-Length (chunked upload)", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const chunk = new Uint8Array(64 * 1024).fill(32);
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent >= 5 * 1024 * 1024) c.close(); else { sent += chunk.length; c.enqueue(chunk); } },
  });
  const req = new Request(`https://prl.test/v1/devices/${tok(1)}`, { method: "PUT", body, duplex: "half" });
  assert.equal(req.headers.get("content-length"), null);
  const res = await worker.fetch(req, env, {});
  assert.equal(res.status, 413);
  assert.ok(sent < 5 * 1024 * 1024);                                     // stopped reading early
  const live = await call(env, "PUT", `/v1/live/${liveTok(1)}`, { env: "production", topic: "com.prl.wizard", pad: "x".repeat(9000) });
  assert.equal(live.status, 413);
});

test("devices (#3): a new token must be one APNs recognizes", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  net.apns = () => ({ status: 400, reason: "BadDeviceToken" });
  assert.equal((await register(env, tok(1), [above()])).status, 400);
  assert.equal(devices(env).length, 0);
  assert.deepEqual(net.calls.map((c) => [c.host, c.headers["apns-push-type"], c.headers["apns-priority"]]),
                   [["api.push.apple.com", "background", "5"], ["api.sandbox.push.apple.com", "background", "5"]]);
  // A Debug build that guessed its environment wrong is corrected, and proven.
  net.apns = (c) => (c.host.startsWith("api.sandbox") ? { status: 200 } : { status: 400, reason: "BadDeviceToken" });
  assert.equal((await register(env, tok(2), [above()])).status, 200);
  assert.deepEqual(devices(env), [{ token: tok(2), env: "sandbox", verified_at: T0, otid: null }]);
  // Re-syncing a known device costs no APNs request.
  const n = net.calls.length;
  assert.equal((await register(env, tok(2), [above("r", 0.6)], { env: "sandbox" })).status, 200);
  assert.equal(net.calls.length, n);
  // APNs unreachable: registered, but unproven (and budgeted in the tick).
  net.apns = () => ({ status: 503 });
  assert.equal((await register(env, tok(3), [above()])).status, 200);
  assert.equal(env.DB.one("SELECT verified_at FROM devices WHERE token = ?", tok(3)).verified_at, null);
});

test("devices (#3): new tokens have their own, tighter rate limit", async () => {
  setNow(T0);
  installFetch();
  let allowed = 1;
  const env = makeEnv({ RL: { limit: async () => ({ success: true }) }, RL_NEW: { limit: async () => ({ success: allowed-- > 0 }) } });
  assert.equal((await register(env, tok(1), [above()])).status, 200);
  assert.equal((await register(env, tok(2), [above()])).status, 429);
  assert.equal((await register(env, tok(1), [above("r", 0.7)])).status, 200);   // known device: not counted
});

test("devices (#2): pro_jws — verified, stored, forged ones refused, older apps let in", async () => {
  setNow(T0);
  installFetch();
  const chain = await makeChain();
  const env = makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256 });
  const pro = await signJWS(chain, proTx());
  assert.equal((await register(env, tok(1), [above()], { pro_jws: pro })).status, 200);
  assert.equal(devices(env)[0].otid, "1000001");
  // A re-sync without it keeps the purchase on file.
  assert.equal((await register(env, tok(1), [above()])).status, 200);
  assert.equal(devices(env)[0].otid, "1000001");

  const refused = [
    await signJWS(await makeChain(), proTx()),                         // not Apple's (not the pinned root)
    await signJWS(chain, proTx({ productId: "com.prl.wizard.other" })),
    await signJWS(chain, proTx({ bundleId: "com.evil" })),
    await signJWS(chain, proTx({ revocationDate: Date.UTC(2026, 8, 2) })),
    pro.slice(0, -6) + "AAAAAA",
    "",
    12,
  ];
  for (const jws of refused) assert.equal((await register(env, tok(2), [above()], { pro_jws: jws })).status, 403);
  assert.equal(devices(env).length, 1);

  // Apps before 1.17 send nothing: let in (no purchase on file) unless REQUIRE_PRO.
  assert.equal((await register(env, tok(3), [above()])).status, 200);
  // Xcode's local StoreKit testing: its own certificate, treated as not sent.
  const xcode = await signJWS(await makeChain(), proTx({ environment: "Xcode" }));
  assert.equal((await register(env, tok(4), [above()], { pro_jws: xcode })).status, 200);
  env.REQUIRE_PRO = "1";
  assert.equal((await register(env, tok(5), [above()])).status, 403);
  assert.equal((await register(env, tok(5), [above()], { pro_jws: xcode })).status, 403);
  assert.equal((await register(env, tok(5), [above()], { pro_jws: pro })).status, 200);
});

test("live: registration with started_at and pro_jws", async () => {
  setNow(T0);
  installFetch();
  const chain = await makeChain();
  const env = makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256 });
  const put = (t, body) => call(env, "PUT", `/v1/live/${t}`, { env: "production", topic: "com.prl.wizard", ...body });
  assert.equal((await put("zz", {})).status, 400);
  assert.equal((await put(liveTok(1), { topic: "com.evil" })).status, 400);
  assert.equal((await put(liveTok(1), { pro_jws: await signJWS(await makeChain(), proTx()) })).status, 403);
  assert.equal((await put(liveTok(1), { started_at: T0 - 600, pro_jws: await signJWS(chain, proTx()) })).status, 200);
  setNow(T0 + 60);
  assert.equal((await put(liveTok(1), { started_at: T0 })).status, 200);     // relaunch: keeps the earlier start
  assert.deepEqual(env.DB.one("SELECT started_at, original_transaction_id AS otid FROM live"), { started_at: T0 - 600, otid: "1000001" });
  assert.equal((await call(env, "DELETE", `/v1/live/${liveTok(1)}`)).status, 200);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM live").n, 0);
});

test("devices (#9): reading the rules back is a check-in, recorded at most hourly", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  await register(env, tok(1), [above()]);
  const seenAt = () => env.DB.one("SELECT seen_at FROM devices").seen_at;
  assert.equal(seenAt(), T0);
  setNow(T0 + 600);
  await call(env, "GET", `/v1/devices/${tok(1)}`);
  assert.equal(seenAt(), T0);
  setNow(T0 + 3601);
  const res = await call(env, "GET", `/v1/devices/${tok(1)}`);
  assert.equal(seenAt(), T0 + 3601);
  assert.equal(res.body.rules.length, 1);
});

// ── App Store notifications ──────────────────────────────────────────────────

async function asnBody(chain, type, tx, extra = {}) {
  const signedTransactionInfo = tx ? await signJWS(chain, tx) : undefined;
  return {
    signedPayload: await signJWS(chain, {
      notificationType: type, notificationUUID: `u-${type}-${extra.n || 0}`, version: "2.0", signedDate: Date.UTC(2026, 8, 20),
      data: { bundleId: "com.prl.wizard", environment: "Production", ...(signedTransactionInfo ? { signedTransactionInfo } : {}) },
    }),
  };
}

test("asn (#6): with ASN_STRICT only Apple-signed notifications get through", async () => {
  setNow(T0);
  const net = installFetch();
  const chain = await makeChain();
  const env = makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256, ASN_STRICT: "1" });
  const good = await asnBody(chain, "ONE_TIME_CHARGE", proTx({ price: 2990, currency: "USD", storefront: "USA" }));
  assert.equal((await call(env, "POST", "/v1/asn/wrong", good)).status, 404);
  const forged = await asnBody(await makeChain(), "ONE_TIME_CHARGE", proTx());
  assert.equal((await call(env, "POST", "/v1/asn/asn-secret", forged)).status, 401);
  const unsigned = { signedPayload: ["eyJhbGciOiJFUzI1NiJ9", Buffer.from("{}").toString("base64url"), "sig"].join(".") };
  assert.equal((await call(env, "POST", "/v1/asn/asn-secret", unsigned)).status, 401);
  assert.equal(net.calls.length, 0);

  const res = await call(env, "POST", "/v1/asn/asn-secret", good);
  assert.deepEqual(res, { status: 200, body: { ok: true } });
  assert.equal(net.calls.length, 0);
});

test("asn: without ASN_STRICT an unverified notification can't drop anyone", async () => {
  setNow(T0);
  const net = installFetch();
  const chain = await makeChain();
  const env = makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256 });
  await register(env, tok(1), [above()], { pro_jws: await signJWS(chain, proTx({ originalTransactionId: "111" })) });
  const other = await makeChain();   // not Apple's root → fails verification
  const buy = await asnBody(other, "ONE_TIME_CHARGE", proTx({ price: 2990, currency: "USD", storefront: "USA" }));
  assert.deepEqual(await call(env, "POST", "/v1/asn/asn-secret", buy), { status: 200, body: { ok: true } });
  const refund = await asnBody(other, "REFUND", proTx({ originalTransactionId: "111" }), { n: 1 });
  assert.equal((await call(env, "POST", "/v1/asn/asn-secret", refund)).status, 200);
  assert.deepEqual(devices(env).map((d) => d.token), [tok(1)]);   // still there
  assert.equal((await call(env, "POST", "/v1/asn/wrong", buy)).status, 404);
});

test("asn (#2): a refund stops the pushes of every device registered with that purchase", async () => {
  setNow(T0);
  const net = installFetch();
  const chain = await makeChain();
  const env = makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256 });
  const pro = (otid) => signJWS(chain, proTx({ originalTransactionId: otid }));
  await register(env, tok(1), [above()], { pro_jws: await pro("111") });
  await register(env, tok(2), [above()], { pro_jws: await pro("222") });
  await call(env, "PUT", `/v1/live/${liveTok(1)}`, { env: "production", topic: "com.prl.wizard", pro_jws: await pro("111") });
  const refund = await asnBody(chain, "REFUND", proTx({ originalTransactionId: "111" }));
  assert.equal((await call(env, "POST", "/v1/asn/asn-secret", refund)).status, 200);
  assert.deepEqual(devices(env).map((d) => d.token), [tok(2)]);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM rules WHERE token = ?", tok(1)).n, 0);
  assert.equal(env.DB.one("SELECT count(*) AS n FROM live").n, 0);
  const before = net.alerts().length;
  await tick(env);
  assert.deepEqual(net.alerts().slice(before).map((c) => c.token), [tok(2)]);
});

// ── price / ingest ───────────────────────────────────────────────────────────

test("price (#5): one read per request, a stale flag, 503 before the first tick", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/v1/price")).status, 503);
  await tick(env);
  env.DB.log.length = 0;
  const res = await call(env, "GET", "/v1/price");
  assert.equal(res.status, 200);
  // Clients must not keep it: Cloudflare stretched a client max-age=15 to 4 hours.
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(res.body, { usd: 0.8, ts: T0, source: "median", change5m: null, change1h: null,
                               change24h: (0.8 - 0.78) / 0.78 * 100, stale: false });
  assert.equal(env.DB.log.length, 1);
  setNow(T0 + 301);
  assert.equal((await call(env, "GET", "/v1/price")).body.stale, true);

  // A database from before this version (no cached reply) still answers.
  env.DB.raw.exec("DELETE FROM kv WHERE k = 'price'");
  assert.equal((await call(env, "GET", "/v1/price")).body.usd, 0.8);
});

test("price: changes compare against history of the same source", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  env.DB.raw.prepare("INSERT INTO prices (ts, usd, src) VALUES (?, 0.64, 'median')").run(T0 - 3600);
  env.DB.raw.prepare("INSERT INTO prices (ts, usd, src) VALUES (?, 0.1, 'safetrade')").run(T0 - 300);
  net.price = 0.8;
  await tick(env);
  const res = (await call(env, "GET", "/v1/price")).body;
  assert.equal(Math.round(res.change1h), 25);
  assert.equal(res.change5m, null);
});

test("ingest: bearer auth, body validation", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const body = { at: String(T0), ticker: { last: "0.81", open: "0.7" } };
  assert.equal((await call(env, "POST", "/v1/ingest/safetrade", body, { authorization: "Bearer nope" })).status, 401);
  assert.equal((await call(env, "POST", "/v1/ingest/safetrade", "{", { authorization: "Bearer ingest-token" })).status, 400);
  assert.equal((await call(env, "POST", "/v1/ingest/safetrade", { at: "1" }, { authorization: "Bearer ingest-token" })).status, 400);
  assert.deepEqual((await call(env, "POST", "/v1/ingest/safetrade", body, { authorization: "Bearer ingest-token" })).body, { ok: true, last: 0.81 });
  await tick(env);
  assert.equal(env.DB.one("SELECT src, usd FROM prices").src, "safetrade");
});

test("test push: throttled to one a minute", async () => {
  setNow(T0);
  const net = installFetch();
  const env = makeEnv();
  await register(env, tok(1), [above()]);
  assert.equal((await call(env, "POST", `/v1/devices/${tok(2)}/test`)).status, 404);
  assert.equal((await call(env, "POST", `/v1/devices/${tok(1)}/test`)).status, 200);
  assert.equal((await call(env, "POST", `/v1/devices/${tok(1)}/test`)).status, 429);
  assert.equal(net.alerts().length, 1);
});

test("gpus: serves the shared GPU table the app bundles", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  const res = await call(env, "GET", "/v1/gpus");
  assert.equal(res.status, 200);
  assert.match(res.body.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(res.body.gpus.length, 27);
  for (const g of res.body.gpus) {
    assert.ok(g.name && g.th > 0 && g.watts > 0 && g.price > 0 && g.rentDefault >= 0, g.name);
  }
  assert.equal(new Set(res.body.gpus.map((g) => g.name)).size, 27);
  assert.equal(res.body.gpus.find((g) => g.name === "RTX 5090").th, 400);
});
