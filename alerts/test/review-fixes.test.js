import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupAccount, login, challenge, request } from "./account-fixture.js";
import { makeSession, random } from "../src/auth.js";
import { sha256 } from "../src/http.js";
import { setNow, restoreNow, T0, tok, makeChain, signJWS, proTx, installFetch, tick } from "./helpers.js";
import { revokeDevice } from "../src/account-lifecycle.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; restoreNow(); });
const settings = (extra = {}) => ({ topic: "com.prl.wizard", env: "production", rules: [
  { id: "r", kind: "above", value: 0.7, window: 0, enabled: true, repeat: true },
], watches: [{ id: "w", pool: "Kryptex", addr: "prl1p" + "q".repeat(39) + "1", label: "", after: 600 }], ...extra });
async function native(f, account, pro = true) {
  const data = await makeSession(f.env, account.user_id, { device_id: random(24), platform: "ios" }, "native");
  if (pro) f.env.DB.raw.prepare("INSERT OR IGNORE INTO entitlements VALUES('admin',?,?,'pro','web',?,NULL)")
    .run(account.user_id, account.user_id, T0);
  return { ...data, credentials: { Authorization: `Bearer ${data.access_token}`, "X-Account-ID": data.user_id } };
}
const count = (db, table, token) => db.one(`SELECT COUNT(*) n FROM ${table} WHERE token=?`, token).n;

for (const lifecycle of ["logout", "remove", "email", "delete"]) {
  for (const nextOwner of ["guest", "account"]) {
    test(`review 1: ${lifecycle} releases notification/live tokens for ${nextOwner}, never the revoked session`, async () => {
      setNow(T0);
      const chain = await makeChain(), f = setupAccount({ APPLE_ROOT_SHA256: chain.rootSHA256 });
      const a = await login(f), d = await native(f, a), token = tok(501), live = tok(502);
      assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, settings(), d.credentials)).status, 200);
      assert.equal((await request(f.env, "PUT", `/v1/live/${live}`, settings(), d.credentials)).status, 200);
      f.env.DB.raw.prepare("INSERT INTO deferred(token,rule_id,kind,value,window,fired_at) VALUES(?,'r','above',0.7,0,?)").run(token, T0);
      if (lifecycle === "logout") assert.equal((await request(f.env, "POST", "/v1/auth/logout", {}, d.credentials)).status, 200);
      if (lifecycle === "remove") assert.equal((await request(f.env, "DELETE", `/v1/account/devices/${d.device_id}`, {}, a.credentials)).status, 200);
      if (lifecycle === "email") {
        setNow(T0 + 60);
        const old = await challenge(f, "person@qq.com", "change_old", a.credentials);
        const next = await challenge(f, "next@fixture.test", "change_new", a.credentials);
        assert.equal((await request(f.env, "POST", "/v1/account/email", { old, next }, a.credentials)).status, 200);
      }
      if (lifecycle === "delete") {
        setNow(T0 + 60);
        const proof = await challenge(f, "person@qq.com", "delete", a.credentials);
        assert.equal((await request(f.env, "DELETE", "/v1/account", proof, a.credentials)).status, 200);
      }
      for (const table of ["devices", "rules", "watches", "deferred"]) assert.equal(count(f.env.DB, table, token), 0, table);
      assert.equal(count(f.env.DB, "live", live), 0);
      let credentials = {}, body = settings({ pro_jws: await signJWS(chain, proTx()) });
      if (nextOwner === "account") credentials = (await native(f, await login(f, "other@fixture.test"))).credentials;
      // Check stale credentials before and after the token is reclaimed.
      for (const method of ["PUT", "GET", "DELETE"]) {
        assert.equal((await request(f.env, method, `/v1/devices/${token}`, method === "PUT" ? body : undefined, d.credentials)).status, 401);
      }
      assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, body, credentials)).status, 200);
      assert.equal((await request(f.env, "PUT", `/v1/live/${live}`, body, credentials)).status, 200);
      assert.equal((await request(f.env, "GET", `/v1/devices/${token}`, undefined, credentials)).status, 200);
      assert.equal((await request(f.env, "DELETE", `/v1/live/${live}`, undefined, d.credentials)).status, 401);
      assert.equal((await request(f.env, "DELETE", `/v1/devices/${token}`, undefined, d.credentials)).status, 401);
      assert.equal(count(f.env.DB, "rules", token), 1);
      assert.equal((await request(f.env, "DELETE", `/v1/live/${live}`, undefined, credentials)).status, 200);
      assert.equal((await request(f.env, "DELETE", `/v1/devices/${token}`, undefined, credentials)).status, 200);
    });
  }
}

test("review 1: an active claim rejects guests and other installations/accounts", async () => {
  setNow(T0);
  const f = setupAccount(), a = await login(f), d = await native(f, a), token = tok(503);
  assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, settings(), d.credentials)).status, 200);
  for (const credentials of [{}, (await native(f, a)).credentials, (await native(f, await login(f, "other@fixture.test"))).credentials]) {
    for (const method of ["PUT", "GET", "DELETE"]) assert.equal((await request(f.env, method, `/v1/devices/${token}`, method === "PUT" ? settings() : undefined, credentials)).status, 401);
  }
});

test("review 2: lost refresh response can be recovered after 20 minutes and repeatedly without logging out", async () => {
  setNow(T0);
  const f = setupAccount(), d = await native(f, await login(f));
  const first = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
  assert.equal(first.status, 200);
  for (const offset of [1200, 7200]) {
    setNow(T0 + offset);
    const recovered = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
    assert.equal(recovered.status, 200);
    assert.deepEqual(Object.keys(recovered.data).sort(), ["user_id", "device_id", "access_token", "refresh_token", "expires_in"].sort());
    assert.equal(recovered.data.user_id, d.user_id);
    assert.equal(recovered.data.device_id, d.device_id);
    assert.equal(recovered.data.expires_in, 900);
    assert.equal(f.env.DB.one("SELECT revoked_at FROM sessions WHERE device_id=?", d.device_id).revoked_at, null);
    if (offset === 7200) {
      const credentials = { Authorization: `Bearer ${recovered.data.access_token}`, "X-Account-ID": d.user_id };
      assert.equal((await request(f.env, "GET", "/v1/account", undefined, credentials)).status, 200);
      assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: recovered.data.refresh_token })).status, 200);
    }
  }
});

test("review 2: retrying an unexpired unused generation returns the same credentials and remaining lifetime", async () => {
  setNow(T0);
  const f = setupAccount(), d = await native(f, await login(f));
  const first = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
  assert.equal(first.status, 200);
  setNow(T0 + 120);
  const retry = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, { ...first.data, expires_in: 780 });
  const stored = JSON.stringify([f.env.DB.rows("SELECT * FROM sessions"), f.env.DB.rows("SELECT * FROM refresh_history")]);
  for (const token of [d.refresh_token, first.data.access_token, first.data.refresh_token]) assert.equal(stored.includes(token), false);
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${retry.data.access_token}` })).status, 200);
});

test("review 2: a recovery committed while another request reads history cannot look like theft", async () => {
  setNow(T0);
  let armed = false, raced = false, winner, d;
  const f = setupAccount({}, { before: async (sql) => {
    if (armed && !raced && sql.includes("FROM refresh_history h JOIN sessions")) {
      raced = true;
      winner = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
      assert.equal(winner.status, 200);
    }
  } });
  d = await native(f, await login(f));
  assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })).status, 200);
  setNow(T0 + 1200); armed = true;
  const retry = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
  assert.equal(raced, true); assert.equal(retry.status, 200); assert.deepEqual(retry.data, winner.data);
  assert.equal(f.env.DB.one("SELECT revoked_at FROM sessions WHERE device_id=?", d.device_id).revoked_at, null);
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${retry.data.access_token}` })).status, 200);
});

for (const expiry of ["logout", "idle", "max", "deleted"]) {
  test(`review 2: response recovery cannot revive a session after ${expiry}`, async () => {
    setNow(T0);
    const f = setupAccount(), d = await native(f, await login(f));
    assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })).status, 200);
    if (expiry === "logout") await f.env.DB.batch(revokeDevice(f.env.DB, d.user_id, d.device_id));
    else if (expiry === "deleted") f.env.DB.raw.prepare("UPDATE users SET deleted_at=? WHERE id=?").run(T0, d.user_id);
    else f.env.DB.raw.prepare(`UPDATE sessions SET ${expiry}_expires=? WHERE device_id=?`).run(T0 + 1000, d.device_id);
    setNow(T0 + 1200);
    assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })).status, 401);
  });
}

for (const use of ["access", "refresh"]) {
  test(`review 2: using the successor ${use} token makes a later replay of the previous refresh revoke the session`, async () => {
    setNow(T0);
    const f = setupAccount(), d = await native(f, await login(f));
    const result = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token });
    assert.equal(result.status, 200);
    let current = result.data;
    if (use === "access") assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${current.access_token}` })).status, 200);
    else {
      const next = await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: current.refresh_token });
      assert.equal(next.status, 200); current = next.data;
    }
    // A duplicate right behind the refresh that went through is told to wait, as before
    // the recovery existed: two contexts of one client can race, and that is not theft.
    setNow(T0 + 15);
    assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })).status, 409);
    assert.equal(f.env.DB.one("SELECT revoked_at FROM sessions WHERE device_id=?", d.device_id).revoked_at, null);
    assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${current.access_token}` })).status, 200);
    setNow(T0 + 16);
    assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })).status, 401);
    assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${current.access_token}` })).status, 401);
    assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: current.refresh_token })).status, 401);
    assert.ok(f.env.DB.one("SELECT revoked_at FROM sessions WHERE device_id=?", d.device_id).revoked_at);
  });
}

for (const recovering of [false, true]) {
  test(`review 2: concurrent ${recovering ? "recovery" : "rotation"} does not revoke or return unusable credentials`, async () => {
    setNow(T0);
    const f = setupAccount(), d = await native(f, await login(f));
    if (recovering) {
      assert.equal((await request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })).status, 200);
      setNow(T0 + 1200);
    }
    const results = await Promise.all([1, 2].map(() => request(f.env, "POST", "/v1/auth/refresh", { refresh_token: d.refresh_token })));
    assert.ok(results.some(r => r.status === 200));
    for (const r of results) {
      assert.ok([200, 409].includes(r.status), String(r.status));
      if (r.status === 200) assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${r.data.access_token}` })).status, 200);
    }
    assert.equal(f.env.DB.one("SELECT revoked_at FROM sessions WHERE device_id=?", d.device_id).revoked_at, null);
  });
}

test("review 3: empty account registration clears unclaimed guest rules, deferred pushes and monitors", async () => {
  setNow(T0);
  const chain = await makeChain(), f = setupAccount({ APPLE_ROOT_SHA256: chain.rootSHA256 });
  const token = tok(504), guest = settings({ pro_jws: await signJWS(chain, proTx()) });
  assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, guest)).status, 200);
  f.env.DB.raw.prepare("INSERT INTO deferred(token,rule_id,kind,value,window,fired_at) VALUES(?,'r','above',0.7,0,?)").run(token, T0);
  const d = await native(f, await login(f), false);
  assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, settings({ rules: [], watches: [] }), d.credentials)).status, 200);
  for (const table of ["rules", "deferred", "watches", "devices"]) assert.equal(count(f.env.DB, table, token), 0, table);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM miners").n, 0);
  const network = installFetch(); await tick(f.env);
  assert.equal(network.calls.some(c => c.token === token), false);
});

test("review 4: notification registration binds ownership/pro guards and still merges rule/watch state", async () => {
  setNow(T0);
  let armed = false, sid, token = tok(505), writes = 0;
  const f = setupAccount({}, { before: (sql, params) => {
    if (armed && /^\s*(INSERT|UPDATE|DELETE)/.test(sql)) {
      assert.equal(sql.includes(sid), false, "session id must be bound");
      assert.equal(sql.includes(token), false, "token must be bound");
      if (/INTO (devices|rules|watches|miners)/.test(sql)) {
        writes++;
        assert.ok(params.includes(sid), "write must bind session guard");
      }
    }
  } });
  const d = await native(f, await login(f));
  sid = f.env.DB.one("SELECT id FROM sessions WHERE access_hash=?", await sha256(d.access_token)).id;
  armed = true;
  assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, settings(), d.credentials)).status, 200);
  f.env.DB.raw.prepare("UPDATE rules SET armed=0,last_fired=? WHERE token=?").run(T0, token);
  f.env.DB.raw.prepare("UPDATE watches SET told='fixture-state' WHERE token=?").run(token);
  assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, settings(), d.credentials)).status, 200);
  assert.deepEqual(f.env.DB.one("SELECT armed,last_fired,repeating FROM rules WHERE token=?", token), { armed: 0, last_fired: T0, repeating: 1 });
  assert.equal(f.env.DB.one("SELECT told FROM watches WHERE token=?", token).told, "fixture-state");
  assert.ok(writes >= 8);
});

for (const empty of [false, true]) {
  test(`review 4: revocation during ${empty ? "empty" : "nonempty"} registration returns an error and cannot write`, async () => {
    setNow(T0);
    let armed = false, raced = false, d;
    const f = setupAccount({}, { beforeBatch: async (stmts) => {
      if (armed && !raced && stmts.some(s => s.sql.includes(empty ? "DELETE FROM rules WHERE token = ?" : "INSERT INTO devices"))) {
        raced = true; await f.env.DB.batch(revokeDevice(f.env.DB, d.user_id, d.device_id));
      }
    } });
    d = await native(f, await login(f)); armed = true;
    const token = tok(506);
    const result = await request(f.env, "PUT", `/v1/devices/${token}`, settings(empty ? { rules: [], watches: [] } : {}), d.credentials);
    assert.equal(raced, true); assert.equal(result.status, 401);
    for (const table of ["devices", "rules", "watches"]) assert.equal(count(f.env.DB, table, token), 0);
    assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM miners").n, 0);
  });
}

for (const buyer of ["account", "guest"]) {
  test(`review 5: admin grant settles an order created through the real ${buyer} checkout route`, async () => {
    setNow(T0);
    const f = setupAccount({ PAY_ADDRESS: "prl1" + "a".repeat(38), ADMIN_TOKEN: "admin" });
    let gid, credentials;
    if (buyer === "account") { const d = await native(f, await login(f), false); gid = d.user_id; credentials = d.credentials; }
    else {
      const v = await request(f.env, "POST", "/v1/purchase/session", { device_id: random(24) });
      assert.equal(v.status, 200); gid = v.data.purchase_id; credentials = { "X-Purchase-Key": v.data.purchase_key };
    }
    f.env.DB.raw.prepare("INSERT INTO kv(k,v,ts) VALUES('price',?,?)").run(JSON.stringify({ usd: 0.8, ts: T0 }), T0);
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url) === "https://blockbook.pearlresearch.ai/api/"
      ? Response.json({ blockbook: { bestHeight: 1000, inSync: true } }) : previous(url, init);
    const order = await request(f.env, "POST", "/v1/orders", undefined, credentials);
    assert.equal(order.status, 200);
    assert.equal(f.env.DB.one("SELECT gid FROM orders WHERE id=?", order.data.id).gid, gid);
    const txid = "d".repeat(64);
    f.env.DB.raw.prepare("INSERT INTO payments(txid,sats,first_seen,confirmed) VALUES(?,?,?,1)").run(txid, order.data.sats, T0);
    const result = await request(f.env, "POST", "/v1/admin/grant", { order_id: order.data.id, txid }, { Authorization: "Bearer admin" });
    assert.equal(result.status, 200);
    assert.deepEqual(f.env.DB.one("SELECT status,txid FROM orders WHERE id=?", order.data.id), { status: "paid", txid });
    assert.equal(f.env.DB.one("SELECT order_id FROM payments WHERE txid=?", txid).order_id, order.data.id);
    assert.deepEqual(f.env.DB.one("SELECT pro_src,pro_ref FROM groups WHERE gid=?", gid), { pro_src: "admin", pro_ref: txid });
    assert.equal((await request(f.env, "POST", "/v1/admin/grant", { gid, note: "follow-up" }, { Authorization: "Bearer admin" })).status, 200);
  });
}
