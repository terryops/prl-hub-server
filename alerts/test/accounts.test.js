import { revokeDevice } from "../src/account-lifecycle.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setNow, restoreNow, T0, makeChain, signJWS, proTx, tok } from "./helpers.js";
import { setupAccount, request, challenge, login, configFixture } from "./account-fixture.js";
import { makeSession, random } from "../src/auth.js";
import { sha256 } from "../src/http.js";
import { encrypt, decrypt } from "../src/account-config.js";
import { claimPush } from "../src/account.js";
import { deliver, accountPushAllowed } from "../src/push.js";
import { pruneEmptyGroups, pruneGroups } from "../src/groupstore.js";
import { revokeApple } from "../src/apple.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; restoreNow(); });
const boot = (extra = {}, hooks = {}) => { setNow(T0); return setupAccount(extra, hooks); };

const nativeSettings = () => ({ topic:"com.prl.wizard", env:"production", rules:[{id:"r",kind:"above",value:1.2,window:0,enabled:true}],
  watches:[{id:"w",pool:"Kryptex",addr:"prl1p"+"q".repeat(39)+"1",label:"",after:600}] });
const paidOrder = (db, uid, status="paid") => db.raw.prepare(`INSERT INTO orders(id,gid,usd,rate,sats,created_at,expires_at,status,txid,paid_at)
  VALUES('account-pro-order',?,4.99,1,499000001,?,?,?,'confirmed-prl-payment',?)`).run(uid,T0,T0+1800,status,status==="paid"?T0:null);
const grantPro = (db,uid) => db.raw.prepare("INSERT INTO entitlements VALUES('admin',?,?,'pro','web',?,NULL)").run(uid,uid,T0);

test("account: only confirmed PRL payment authorizes native alerts, watches and live activity without Apple", async () => {
  const f=boot({REQUIRE_PRO:"0"}),a=await login(f),d=await makeSession(f.env,a.user_id,{device_id:random(24),platform:"ios"},"native"),
    credentials={Authorization:`Bearer ${d.access_token}`},token=tok(120),live=tok(121);
  paidOrder(f.env.DB,a.user_id,"pending");
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,{...nativeSettings(),watches:[],pro:true},credentials)).status,403);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,nativeSettings(),credentials)).status,403);
  assert.equal((await request(f.env,"PUT",`/v1/live/${live}`,{topic:"com.prl.wizard",env:"production",pro:true},credentials)).status,403);
  f.env.DB.raw.prepare("UPDATE orders SET status='expired' WHERE id='account-pro-order'").run();
  assert.equal((await request(f.env,"GET","/v1/me",undefined,credentials)).data.pro,false);
  f.env.DB.raw.prepare("UPDATE orders SET status='paid',paid_at=? WHERE id='account-pro-order'").run(T0);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,nativeSettings(),credentials)).status,200);
  assert.equal((await request(f.env,"PUT",`/v1/live/${live}`,{topic:"com.prl.wizard",env:"production"},credentials)).status,200);
  assert.equal(f.env.DB.one("SELECT account_pro FROM devices WHERE token=?",token).account_pro,1);
  assert.equal(f.env.DB.one("SELECT account_pro FROM live WHERE token=?",live).account_pro,1);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM watches WHERE token=?",token).n,1);
  assert.equal(await accountPushAllowed(f.env.DB,token),true);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,nativeSettings())).status,401);
  const other=await login(f,"other@163.com");
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,nativeSettings(),other.credentials)).status,401);
  f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=? WHERE user_id=?").run(T0,a.user_id);
  assert.equal((await request(f.env,"GET","/v1/me",undefined,credentials)).data.pro,false);
  assert.equal(await accountPushAllowed(f.env.DB,token),false);
  assert.equal(await accountPushAllowed(f.env.DB,live),false);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,nativeSettings(),credentials)).status,403);
});

test("account: Apple refund keeps native devices with independent PRL, and final refund removes account push", async () => {
  const chain=await makeChain(),f=boot({APPLE_ROOT_SHA256:chain.rootSHA256,REQUIRE_PRO:"1"}),a=await login(f),
    d=await makeSession(f.env,a.user_id,{device_id:random(24),platform:"ios"},"native"),credentials={Authorization:`Bearer ${d.access_token}`},
    token=tok(122),live=tok(123),jws=await signJWS(chain,proTx());
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws},a.credentials)).status,200);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,{...nativeSettings(),pro_jws:jws},credentials)).status,200);
  assert.equal((await request(f.env,"PUT",`/v1/live/${live}`,{topic:"com.prl.wizard",env:"production",pro_jws:jws},credentials)).status,200);
  // Simulate a pre-update receipt-authorized device to verify the upgrade path.
  f.env.DB.raw.prepare("UPDATE devices SET original_transaction_id='1000001',account_pro=0 WHERE token=?").run(token);
  f.env.DB.raw.prepare("UPDATE live SET original_transaction_id='1000001',account_pro=0 WHERE token=?").run(live);
  paidOrder(f.env.DB,a.user_id);
  await revokeApple(f.env,"1000001");
  assert.equal(f.env.DB.one("SELECT account_pro FROM devices WHERE token=?",token).account_pro,1);
  assert.equal(f.env.DB.one("SELECT account_pro FROM live WHERE token=?",live).account_pro,1);
  assert.equal(await accountPushAllowed(f.env.DB,token),true);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,nativeSettings(),credentials)).status,200);
  const b=await login(f,"second@163.com"),bNative=await makeSession(f.env,b.user_id,{device_id:random(24),platform:"ios"},"native"),
    bCred={Authorization:`Bearer ${bNative.access_token}`},jws2=await signJWS(chain,proTx({originalTransactionId:"1000002"}));
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws:jws2},b.credentials)).status,200);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${tok(124)}`,nativeSettings(),bCred)).status,200);
  assert.equal((await request(f.env,"PUT",`/v1/live/${tok(125)}`,{topic:"com.prl.wizard",env:"production"},bCred)).status,200);
  await revokeApple(f.env,"1000002");
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices WHERE token=?",tok(124)).n,0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM live WHERE token=?",tok(125)).n,0);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${tok(124)}`,{...nativeSettings(),pro_jws:jws2},bCred)).status,403);
});

test("account: PRL entitlement revoked during registration cannot resurrect native rules or live activity", async () => {
  let armed=false,raced=false;
  const f=boot({REQUIRE_PRO:"1"},{before:async(sql)=>{
    if(armed&&!raced&&(sql.includes("INSERT INTO devices")||sql.includes("INSERT INTO live"))){
      raced=true;f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=?").run(T0);
      f.env.DB.raw.prepare("UPDATE groups SET pro_at=NULL,pro_src=NULL,pro_ref=NULL").run();
    }
  }}),a=await login(f),d=await makeSession(f.env,a.user_id,{device_id:random(24),platform:"ios"},"native"),credentials={Authorization:`Bearer ${d.access_token}`};
  paidOrder(f.env.DB,a.user_id);
  for (const [path,body] of [[`/v1/devices/${tok(126)}`,nativeSettings()],[`/v1/live/${tok(127)}`,{topic:"com.prl.wizard",env:"production"}]]) {
    f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=NULL").run();armed=true;raced=false;
    assert.equal((await request(f.env,"PUT",path,body,credentials)).status,401);
    assert.equal(raced,true);armed=false;
  }
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices").n,0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM rules").n,0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM watches").n,0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM live").n,0);
});

test("account: sending requires server-side human verification, correct action and origin", async () => {
  const f = boot();
  for (const turnstile of [undefined, "forged", "human-wrong:other"]) {
    const r = await request(f.env, "POST", "/v1/auth/email/start", { email: "person@qq.com", turnstile });
    assert.equal(r.status, 403);
  }
  const r = await request(f.env, "POST", "/v1/auth/email/start", { email: "person@qq.com", turnstile: "human-x" }, { origin: "https://attacker.test" });
  assert.equal(r.status, 403); assert.equal(f.emails.length, 0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM users").n, 0);
});
test("account: OTP creates verified user, protected cookie and no plaintext stored", async () => {
  const f = boot(), s = await login(f);
  const r = await request(f.env, "GET", "/v1/account", undefined, s.credentials);
  assert.equal(r.data.email, "person@qq.com");
  const row = f.env.DB.one("SELECT * FROM auth_challenges");
  assert.notEqual(row.code_hash, s.proof.code); assert.equal(row.attempts, 1);
  assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", s.proof)).status, 401);
  assert.match(s.cookie, /^__Host-prl_session=/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${s.cookie.split("=")[1]}` })).status, 401);
});
test("account: concurrent consumption can create only one successful session", async () => {
  const f = boot(), c = await challenge(f);
  const out = await Promise.all([1, 2, 3].map(() => request(f.env, "POST", "/v1/auth/email/verify", c)));
  assert.equal(out.filter((r) => r.status === 200).length, 1);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM sessions").n, 1);
});
test("account: five attempts, expiry and rolling resend invalidate old code", async () => {
  const f = boot(), c = await challenge(f);
  for (let i=0; i<5; i++) assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", { ...c, code: c.code === "000000" ? "000001" : "000000" })).status, 401);
  assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", c)).status, 401);
  setNow(T0 + 59); assert.equal((await challenge(f)).response.status, 429);
  setNow(T0 + 60); const next = await challenge(f); assert.equal(next.response.status, 200);
  assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", c)).status, 401);
  setNow(T0 + 361); assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", next)).status, 401);
});
test("account: email quota and failed delivery cannot issue usable challenges", async () => {
  const f = boot({ EMAIL_DAILY_LIMIT: "1" });
  assert.equal((await challenge(f)).response.status, 200);
  assert.equal((await challenge(f, "second@163.com")).response.status, 429);
  setNow(T0 + 86400); f.env.EMAIL.send = async () => { throw new Error("mail service unavailable"); };
  const r = await challenge(f); assert.equal(r.response.status, 503);
  const row = f.env.DB.one("SELECT * FROM auth_challenges ORDER BY created_at DESC LIMIT 1");
  assert.ok(row.consumed_at); assert.equal(row.delivered, 0);
});
test("account: CSRF, unknown bearer and account mismatch are refused", async () => {
  const f = boot(), s = await login(f);
  assert.equal((await request(f.env, "PUT", "/v1/account/config", {}, { ...s.credentials, origin: "https://attacker.test" })).status, 401);
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, { Authorization: `Bearer ${random()}` })).status, 401);
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, { ...s.credentials, "x-account-id": "another-account" })).status, 401);
});
test("account: config encrypted with account AAD, atomic revisions and strict secret exclusion", async () => {
  const f = boot(), a = await login(f), b = await login(f, "second@163.com");
  grantPro(f.env.DB, a.user_id); grantPro(f.env.DB, b.user_id);
  const data = configFixture(); data.wallets=[{ id:"watch", updated:Date.now(), addr:"prl1"+"a".repeat(38), label:"Private label" }];
  const body = { schema_version:1, rev:0, data };
  const out = await Promise.all([1, 2].map(() => request(f.env, "PUT", "/v1/account/config", body, a.credentials)));
  assert.deepEqual(out.map((r)=>r.status).sort(), [200,409]);
  const stored = f.env.DB.one("SELECT data FROM account_configs WHERE user_id=?", a.user_id).data;
  assert.ok(!stored.includes("Private label")); assert.deepEqual(await decrypt(f.env, a.user_id, stored), data);
  await assert.rejects(decrypt(f.env, b.user_id, stored));
  assert.equal((await request(f.env, "GET", "/v1/account/config", undefined, b.credentials)).data.data, null);
  for (const changed of [{ ...data, seed:"never upload" }, { ...data, settingsUpdated:Date.now()+300001 },
    { ...data, contacts:[{ id:"contact", updated:Date.now(), name:"x", address:"prl1"+"a".repeat(38), note:"", privateKey:"no" }] }]) {
    assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version:1, rev:1, data:changed }, a.credentials)).status, 400);
  }
});
test("account: configuration key rotation reads old ciphertext", async () => {
  const f = boot(), data=configFixture(), encrypted=await encrypt(f.env,"u_test",data), old=f.env.ACCOUNT_CONFIG_KEY;
  f.env.ACCOUNT_CONFIG_KEY=Buffer.alloc(32,8).toString("base64"); f.env.ACCOUNT_CONFIG_KEY_VERSION="2"; f.env.ACCOUNT_CONFIG_OLD_KEYS=JSON.stringify({1:old});
  assert.deepEqual(await decrypt(f.env,"u_test",encrypted),data);
  assert.ok((await encrypt(f.env,"u_test",data)).startsWith("2."));
});
test("account: device revocation closes old token routes and stops queued delivery", async () => {
  const f=boot(), a=await login(f), native=await makeSession(f.env,a.user_id,{device_id:random(24),platform:"ios"},"native");
  const s=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(native.access_token)), token=tok(1);
  assert.equal(await claimPush(f.env,s,token),true);
  f.env.DB.raw.prepare("INSERT INTO devices(token,env,topic,lang,updated_at,gid,account_device_id) VALUES(?,'production','com.prl.wizard','en',?,?,?)").run(token,T0,a.user_id,s.device_id);
  f.env.DB.raw.prepare("INSERT INTO rules(token,id,kind,value,window,enabled,armed) VALUES(?,'r','above',1,0,1,1)").run(token);
  const credentials={Authorization:`Bearer ${native.access_token}`};
  assert.equal((await request(f.env,"GET",`/v1/devices/${token}`,undefined)).status,401);
  assert.equal((await request(f.env,"GET",`/v1/devices/${token}`,undefined,credentials)).status,200);
  assert.equal((await request(f.env,"DELETE",`/v1/account/devices/${s.device_id}`,{},a.credentials)).status,200);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,credentials)).status,401);
  assert.equal((await request(f.env,"PUT",`/v1/devices/${token}`,{},credentials)).status,401);
  assert.equal((await deliver(f.env,f.env.DB,{token,chan:"apns"},{})).drop,true);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM rules WHERE token=?",token).n,0);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).status,200);
});
test("account: logout revokes installation, while re-login requires a new OTP", async () => {
  const f=boot(), a=await login(f);
  assert.equal((await request(f.env,"POST","/v1/auth/logout",{},a.credentials)).status,200);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).status,401);
  setNow(T0+60); const b=await login(f,"person@qq.com",a.device_id);
  assert.equal(b.user_id,a.user_id); assert.equal((await request(f.env,"GET","/v1/account",undefined,b.credentials)).status,200);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).status,401);
});
test("account: refresh rotates tokens and replay revokes the token family", async () => {
  const f=boot(), a=await login(f), s=await makeSession(f.env,a.user_id,{device_id:random(24),platform:"extension"},"native");
  setNow(T0+901);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,{Authorization:`Bearer ${s.access_token}`})).status,401);
  const result=await request(f.env,"POST","/v1/auth/refresh",{refresh_token:s.refresh_token}); assert.equal(result.status,200);
  const retry=await request(f.env,"POST","/v1/auth/refresh",{refresh_token:s.refresh_token});
  assert.equal(retry.status,200); assert.deepEqual(retry.data,result.data);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,{Authorization:`Bearer ${result.data.access_token}`})).status,200);
  setNow(T0+920); assert.equal((await request(f.env,"POST","/v1/auth/refresh",{refresh_token:s.refresh_token})).status,401);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,{Authorization:`Bearer ${result.data.access_token}`})).status,401);
});
test("account: PKCE exchange binds callback, verifier and one-use authorization", async () => {
  const redirect="https://abcdefgh.chromiumapp.org/account",f=boot({ACCOUNT_REDIRECTS:redirect}),a=await login(f),verifier=random(48);
  const challengeHash=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))).toString("base64url");
  const grant=await request(f.env,"POST","/v1/auth/authorize",{redirect_uri:redirect,code_challenge:challengeHash,device_id:random(24),platform:"extension"},a.credentials);
  assert.equal(grant.status,200);
  assert.equal((await request(f.env,"POST","/v1/auth/exchange",{code:grant.data.code,code_verifier:random(48),redirect_uri:redirect})).status,401);
  const body={code:grant.data.code,code_verifier:verifier,redirect_uri:redirect};
  const out=await request(f.env,"POST","/v1/auth/exchange",body);assert.equal(out.status,200);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,{Authorization:`Bearer ${out.data.access_token}`})).status,200);
  assert.equal((await request(f.env,"POST","/v1/auth/exchange",body)).status,401);
});
test("account: verified free users survive legacy pruning and the anonymous cap", async () => {
  const f=boot({GROUP_LIMIT:"1"}),a=await login(f); setNow(T0+40*86400);
  await f.env.DB.batch([pruneEmptyGroups(f.env.DB,T0+40*86400),pruneGroups(f.env.DB,T0+40*86400)]);
  assert.ok(f.env.DB.one("SELECT * FROM groups WHERE gid=?",a.user_id));
  const b=await login(f,"second@163.com"); assert.notEqual(b.user_id,a.user_id);
});
test("account: email change preserves ownership, revokes other sessions and prevents merging", async () => {
  const f=boot(),a=await login(f),other=await makeSession(f.env,a.user_id,{device_id:random(24)},"native");
  const otherSession=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(other.access_token)),token=tok(94);
  await claimPush(f.env,otherSession,token);
  setNow(T0+60);const old=await challenge(f,"person@qq.com","change_old",a.credentials),next=await challenge(f,"new@163.com","change_new",a.credentials);
  const r=await request(f.env,"POST","/v1/account/email",{old,next},a.credentials);assert.equal(r.status,200);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.user_id,a.user_id);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.email,"new@163.com");
  assert.equal((await request(f.env,"GET","/v1/account",undefined,{Authorization:`Bearer ${other.access_token}`})).status,401);
  assert.equal((await request(f.env,"GET","/v1/account/devices",undefined,a.credentials)).data.devices.length,1);
  assert.ok(f.env.DB.one("SELECT revoked_at FROM account_push_claims WHERE token=?",token).revoked_at);
});
test("account: deletion requires fresh purpose-specific code and retains anti-replay ledger", async () => {
  const f=boot(),a=await login(f);
  f.env.DB.raw.prepare("INSERT INTO entitlements VALUES('apple','123',?,'pro','web',?,NULL)").run(a.user_id,T0);
  assert.equal((await request(f.env,"DELETE","/v1/account",a.proof,a.credentials)).status,401);
  setNow(T0+60);const c=await challenge(f,"person@qq.com","delete",a.credentials);
  assert.equal((await request(f.env,"DELETE","/v1/account",c,a.credentials)).status,200);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).status,401);
  assert.equal(f.env.DB.one("SELECT email FROM users WHERE id=?",a.user_id).email,null);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM account_configs").n,0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n,1);
});
test("account: unique Apple ownership and refund preserve independent PRL entitlement", async () => {
  const chain=await makeChain(),f=boot({APPLE_ROOT_SHA256:chain.rootSHA256}),a=await login(f),b=await login(f,"second@163.com"),jws=await signJWS(chain,proTx());
  const out=await Promise.all([a,b].map((s)=>request(f.env,"POST","/v1/account/entitlements/apple",{jws},s.credentials)));
  assert.deepEqual(out.map((r)=>r.status).sort(),[200,409]);
  const winner=out[0].status===200?a:b;
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws},winner.credentials)).status,200);
  f.env.DB.raw.prepare("INSERT INTO entitlements VALUES('prl','confirmed-payment',?,'pro','web',?,NULL)").run(winner.user_id,T0);
  await revokeApple(f.env,"1000001");
  const r=await request(f.env,"GET","/v1/account/entitlements",undefined,winner.credentials);assert.equal(r.data.pro,true);
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws},winner.credentials)).status,400);
  for(const change of [{bundleId:"wrong"},{productId:"wrong"},{environment:"Sandbox"},{revocationDate:1}])
    assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws:await signJWS(chain,proTx(change))},winner.credentials)).status,400);
});
test("account: settings project to closed notification devices atomically without resetting fired rules", async () => {
  const f=boot(),a=await login(f),d=await makeSession(f.env,a.user_id,{device_id:random(24),platform:"ios"},"native"),s=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(d.access_token)),token=tok(2);
  await claimPush(f.env,s,token);
  grantPro(f.env.DB,a.user_id);
  f.env.DB.raw.prepare("INSERT INTO devices(token,env,topic,oneshot,updated_at,gid,account_device_id) VALUES(?,'production','com.prl.wizard',1,?,?,?)").run(token,T0,a.user_id,d.device_id);
  const data=configFixture();data.rules=[{id:"rule",kind:"above",value:1.2,window:0,enabled:true,seen_fired:0,updated:Date.now()}];
  assert.equal((await request(f.env,"PUT","/v1/account/config",{schema_version:1,rev:0,data},a.credentials)).status,200);
  assert.equal(f.env.DB.one("SELECT value FROM rules WHERE token=?",token).value,1.2);
  f.env.DB.raw.prepare("UPDATE rules SET enabled=0,armed=0,last_fired=? WHERE token=?").run(T0,token);
  assert.equal((await request(f.env,"PUT","/v1/account/config",{schema_version:1,rev:1,data},a.credentials)).status,200);
  assert.equal(f.env.DB.one("SELECT enabled FROM rules WHERE token=?",token).enabled,0);
  const stale={...data,rules:[]};assert.equal((await request(f.env,"PUT","/v1/account/config",{schema_version:1,rev:1,data:stale},a.credentials)).status,409);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM rules WHERE token=?",token).n,1);
  data.rules[0].repeat = true;
  data.rules[0].updated = Date.now() + 1;
  assert.equal((await request(f.env,"PUT","/v1/account/config",{schema_version:1,rev:2,data},a.credentials)).status,200);
  assert.deepEqual(f.env.DB.one("SELECT enabled, armed, last_fired, repeating FROM rules WHERE token=?",token),
    { enabled: 1, armed: 0, last_fired: T0, repeating: 1 });
  const saved = await request(f.env,"GET","/v1/account/config",undefined,a.credentials);
  assert.equal(saved.data.data.rules[0].repeat, true);
});

test("account: switching a browser email revokes its previous account device", async () => {
  const f=boot(),a=await login(f),token=tok(88),s=f.env.DB.one("SELECT * FROM sessions WHERE user_id=?",a.user_id);
  await claimPush(f.env,s,token);
  setNow(T0+60); const proof=await challenge(f,"second@163.com");
  const b=await request(f.env,"POST","/v1/auth/email/verify",{...proof,device_id:a.device_id},a.credentials);
  assert.equal(b.status,200);assert.notEqual(b.data.user_id,a.user_id);
  assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).status,401);
  assert.ok(f.env.DB.one("SELECT revoked_at FROM account_push_claims WHERE token=?",token).revoked_at);
});
test("account: a legitimate fresh login can reclaim its revoked notification token", async () => {
  const f=boot(),a=await login(f),token=tok(89),first=await makeSession(f.env,a.user_id,{device_id:random(24)},"native");
  grantPro(f.env.DB,a.user_id);
  const credentials={Authorization:`Bearer ${first.access_token}`},s=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(first.access_token));
  await claimPush(f.env,s,token); await request(f.env,"POST","/v1/auth/logout",{},credentials);
  const next=await makeSession(f.env,a.user_id,{device_id:first.device_id},"native");
  const reply=await request(f.env,"PUT",`/v1/devices/${token}`,{topic:"com.prl.wizard",env:"production",rules:[{id:"rule",kind:"above",value:1.2,window:0,enabled:true}]},{Authorization:`Bearer ${next.access_token}`});
  assert.equal(reply.status,200); assert.equal(f.env.DB.one("SELECT revoked_at FROM account_push_claims WHERE token=?",token).revoked_at,null);
});
test("account: revocation during notification registration prevents stale row resurrection", async () => {
  let armed=false,raced=false,session;
  const f=boot({}, {beforeBatch: async (stmts) => {
    if(armed&&!raced&&stmts.some(s=>s.sql.includes("INSERT INTO devices"))){raced=true;await f.env.DB.batch(revokeDevice(f.env.DB,session.user_id,session.device_id));}
  }}),a=await login(f),d=await makeSession(f.env,a.user_id,{device_id:random(24)},"native"),token=tok(90);
  grantPro(f.env.DB,a.user_id);
  session=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(d.access_token));armed=true;
  const reply=await request(f.env,"PUT",`/v1/devices/${token}`,{topic:"com.prl.wizard",env:"production",rules:[{id:"rule",kind:"above",value:1.2,window:0,enabled:true}]},{Authorization:`Bearer ${d.access_token}`});
  assert.equal(raced,true);assert.equal(reply.status,401);assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices WHERE token=?",token).n,0);assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM rules WHERE token=?",token).n,0);
});

test("account: invalid live activity registration cannot claim a token, and a revoked write cannot revive it", async () => {
  let armed=false,raced=false,session;
  const f=boot({}, {before: async (sql) => {
    if(armed&&!raced&&sql.includes("INSERT INTO live")){raced=true;await f.env.DB.batch(revokeDevice(f.env.DB,session.user_id,session.device_id));}
  }}),a=await login(f),d=await makeSession(f.env,a.user_id,{device_id:random(24)},"native"),token=tok(91),credentials={Authorization:`Bearer ${d.access_token}`};
  session=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(d.access_token));
  grantPro(f.env.DB,a.user_id);
  assert.equal((await request(f.env,"PUT",`/v1/live/${token}`,{topic:"wrong",env:"production"},credentials)).status,400);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM account_push_claims WHERE token=?",token).n,0);
  armed=true;
  assert.equal((await request(f.env,"PUT",`/v1/live/${token}`,{topic:"com.prl.wizard",env:"production"},credentials)).status,401);
  assert.equal(raced,true);assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM live WHERE token=?",token).n,0);
});
test("account: live claims cannot bypass notification limits or downgrade an existing notification claim", async () => {
  const f=boot(),a=await login(f),s=f.env.DB.one("SELECT * FROM sessions WHERE user_id=?",a.user_id);
  for(let i=0;i<10;i++) {
    const d=i===0?s:f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256((await makeSession(f.env,a.user_id,{device_id:random(24)},"native")).access_token));
    assert.equal(await claimPush(f.env,d,tok(100+i)),true);
  }
  const extra=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256((await makeSession(f.env,a.user_id,{device_id:random(24)},"native")).access_token));
  assert.equal(await claimPush(f.env,extra,tok(110),"live"),true);
  assert.equal(await claimPush(f.env,extra,tok(110)),false);
  assert.equal(await claimPush(f.env,s,tok(100),"live"),true);
  assert.equal(f.env.DB.one("SELECT kind FROM account_push_claims WHERE token=?",tok(100)).kind,"notification");
});
test("account: config write pause preserves reads, and concurrent device revocation prevents a stale config commit", async () => {
  let armed=false,raced=false,session;
  const f=boot({}, {beforeBatch: async (stmts) => {
    if(armed&&!raced&&stmts.some(s=>s.sql.includes("UPDATE account_configs"))){raced=true;await f.env.DB.batch(revokeDevice(f.env.DB,session.user_id,session.device_id));}
  }}),a=await login(f),body={schema_version:1,rev:0,data:configFixture()};
  grantPro(f.env.DB,a.user_id);
  session=f.env.DB.one("SELECT * FROM sessions WHERE user_id=?",a.user_id);
  f.env.ACCOUNT_CONFIG_WRITE_ENABLED="0";
  assert.equal((await request(f.env,"PUT","/v1/account/config",body,a.credentials)).status,503);
  assert.equal((await request(f.env,"GET","/v1/account/config",undefined,a.credentials)).status,200);
  f.env.ACCOUNT_CONFIG_WRITE_ENABLED="1";armed=true;
  assert.equal((await request(f.env,"PUT","/v1/account/config",body,a.credentials)).status,409);
  assert.equal(raced,true);assert.equal(f.env.DB.one("SELECT rev FROM account_configs WHERE user_id=?",a.user_id).rev,0);
});

test("account: exchanging a cached browser login cannot manufacture fresh email verification", async () => {
  const chain=await makeChain(),redirect="prlhub://account",f=boot({APPLE_ROOT_SHA256:chain.rootSHA256,ACCOUNT_REDIRECTS:redirect}),a=await login(f);
  const verifier=random(),digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))),body={redirect_uri:redirect,code_challenge:Buffer.from(digest).toString("base64url"),device_id:random(24),platform:"ios"};
  setNow(T0+600);
  assert.equal((await request(f.env,"POST","/v1/auth/authorize",{...body,reauth:true},a.credentials)).data.error,"fresh_login_required");
  const grant=await request(f.env,"POST","/v1/auth/authorize",body,a.credentials);
  const native=await request(f.env,"POST","/v1/auth/exchange",{code:grant.data.code,code_verifier:verifier,redirect_uri:redirect});assert.equal(native.status,200);
  const s=f.env.DB.one("SELECT email_verified_at FROM sessions WHERE access_hash=?",await sha256(native.data.access_token));assert.equal(s.email_verified_at,T0);
  const receipt=await signJWS(chain,proTx());
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws:receipt},{Authorization:`Bearer ${native.data.access_token}`})).status,403);
  const fresh=await login(f,"person@qq.com",a.device_id),next=await request(f.env,"POST","/v1/auth/authorize",{...body,reauth:true},fresh.credentials);
  const nextNative=await request(f.env,"POST","/v1/auth/exchange",{code:next.data.code,code_verifier:verifier,redirect_uri:redirect});
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws:receipt},{Authorization:`Bearer ${nextNative.data.access_token}`})).status,200);
});
test("account: revoking the authorizing device invalidates an unused PKCE grant", async () => {
  const redirect="prlhub://account",f=boot({ACCOUNT_REDIRECTS:redirect}),a=await login(f),verifier=random();
  const challenge=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))).toString("base64url");
  const grant=await request(f.env,"POST","/v1/auth/authorize",{redirect_uri:redirect,code_challenge:challenge,device_id:random(24),platform:"ios"},a.credentials);
  assert.equal(grant.status,200);
  await request(f.env,"POST","/v1/auth/logout",{},a.credentials);
  assert.equal((await request(f.env,"POST","/v1/auth/exchange",{code:grant.data.code,code_verifier:verifier,redirect_uri:redirect})).status,401);
});

test("account: a long revoked-device history can still be deleted within the D1 query budget", async () => {
  const f=boot({}, {beforeBatch:async(stmts)=>{if(stmts.length>1000)throw new Error("D1 query budget exceeded");}}),a=await login(f);
  f.env.DB.raw.prepare(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<1000)
    INSERT INTO account_devices(id,user_id,name,platform,created_at,seen_at,revoked_at)
    SELECT 'retired-install-'||n,?,'Retired','web',?,?,? FROM history`).run(a.user_id,T0,T0,T0);
  setNow(T0+60);const proof=await challenge(f,"person@qq.com","delete",a.credentials);
  assert.equal((await request(f.env,"DELETE","/v1/account",proof,a.credentials)).status,200);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM account_devices WHERE user_id=?",a.user_id).n,0);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked_at IS NULL",a.user_id).n,0);
});


test("account: notification token rotations use one slot and preserve revoked claims against legacy access", async () => {
  const f=boot(),a=await login(f),s=f.env.DB.one("SELECT * FROM sessions WHERE user_id=?",a.user_id),old=tok(120);
  assert.equal(await claimPush(f.env,s,old),true);
  f.env.DB.raw.prepare("INSERT INTO devices(token,env,topic,updated_at,gid,account_device_id) VALUES(?,'production','com.prl.wizard',?,?,?)").run(old,T0,a.user_id,s.device_id);
  for(let i=1;i<=12;i++) assert.equal(await claimPush(f.env,s,tok(120+i)),true);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM account_push_claims WHERE user_id=? AND kind='notification' AND revoked_at IS NULL",a.user_id).n,1);
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices WHERE token=?",old).n,0);
  assert.equal((await request(f.env,"GET",`/v1/devices/${old}`)).status,401);
  assert.equal(await claimPush(f.env,s,old,"live"),false,"live activity cannot revive a revoked ordinary notification claim");
  for(let i=0;i<9;i++) {
    const d=await makeSession(f.env,a.user_id,{device_id:random(24)},"native"),session=f.env.DB.one("SELECT * FROM sessions WHERE access_hash=?",await sha256(d.access_token));
    assert.equal(await claimPush(f.env,session,tok(140+i)),true);
  }
  assert.equal(await claimPush(f.env,s,tok(133)),true,"rotation remains possible with all ten notification slots occupied");
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM account_push_claims WHERE user_id=? AND kind='notification' AND revoked_at IS NULL",a.user_id).n,10);
});


test("account: another native device receives the complete mining fleet and preferences", async () => {
  const f = boot(), a = await login(f);
  grantPro(f.env.DB, a.user_id);
  const native = await makeSession(f.env, a.user_id, { device_id: random(24), platform: "ios" }, "native");
  const credentials = { Authorization: `Bearer ${native.access_token}`, "X-Account-ID": a.user_id };
  const data = { ...configFixture(), autoRefresh: true, secondary: "JPY", calculator: {
    electricity: 0.2, fee: 2, growth: 15, price: 1.5, yield: 0.04, networkHash: 2e19, rentCoversPower: false,
  }, fleetSettings: {
    powerBudgetW: 6000, powerBudgetEnabled: true, syncWPerTH: 2.2, selfDilution: true, fxManual: true, manualFX: 150,
    rentEnabled: false, growthMode: "manual", sortKey: "efficiency", selectedGPU: "RTX 5090",
    rents: { "RTX 4090": { daily: 12, currency: "USD", fx: 1 } },
  }, devices: [
    { id: "11111111-1111-4111-8111-111111111111", updated: Date.now(), name: "Garage", gpu: "RTX 5090", count: 4, rented: false, hoursPerDay: 18 },
    { id: "22222222-2222-4222-8222-222222222222", updated: Date.now(), name: "Cloud", gpu: "RTX 4090", count: 1, rented: true,
      hoursPerDay: 12, customPearl: 310, rentDaily: 24, rentCurrency: "USD", rentFX: 1, sourceKey: "Kryptex|prl1public|worker" },
  ] };
  assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version: 1, rev: 0, data }, a.credentials)).status, 200);
  const downloaded = await request(f.env, "GET", "/v1/account/config", undefined, credentials);
  assert.deepEqual(downloaded.data.data, data);
  const edited = structuredClone(data);
  edited.devices[0] = { id: edited.devices[0].id, updated: Date.now() + 1, deleted: true };
  edited.devices[1].rentDaily = 30; edited.devices[1].updated += 1;
  edited.fleetSettings.sortKey = "rentNet";
  edited.fleetSettings.powerBudgetEnabled = false;
  assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version: 1, rev: 1, data: edited }, credentials)).status, 200);
  assert.deepEqual((await request(f.env, "GET", "/v1/account/config", undefined, a.credentials)).data.data, edited);
  for (const patch of [{ sortKey: "invalid" }, { selectedGPU: "x".repeat(65) }, { powerBudgetEnabled: "true" }, { powerBudgetEnabled: 1 }, { seed: "never upload" }]) {
    const bad = { ...edited, fleetSettings: { ...edited.fleetSettings, ...patch } };
    assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version: 1, rev: 2, data: bad }, credentials)).status, 400);
  }
});


test("account: free sign-in never enables cloud reads or writes; verified Pro unlocks sync and revocation stops it", async () => {
  const f = boot(), a = await login(f), data = configFixture();
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, a.credentials)).data.pro, false);
  for (const [method, path, body] of [["GET", "/v1/account/config"], ["GET", "/v1/account/export"], ["GET", "/v1/me/config"], ["PUT", "/v1/me/config", { schema_version: 1, rev: 0, data }], ["PUT", "/v1/account/config", { schema_version: 1, rev: 0, data, pro: true }]]) {
    const r = await request(f.env, method, path, body, a.credentials);
    assert.equal(r.status, 403); assert.equal(r.data.error, "sync_requires_pro");
  }
  assert.equal(f.env.DB.one("SELECT data FROM account_configs WHERE user_id=?", a.user_id).data, null);
  paidOrder(f.env.DB, a.user_id, "pending");
  assert.equal((await request(f.env, "GET", "/v1/account/config", undefined, a.credentials)).status, 403);
  f.env.DB.raw.prepare("UPDATE orders SET status='paid',paid_at=? WHERE gid=?").run(T0, a.user_id);
  assert.equal((await request(f.env, "GET", "/v1/account", undefined, a.credentials)).data.pro, true);
  assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version: 1, rev: 0, data }, a.credentials)).status, 200);
  assert.deepEqual((await request(f.env, "GET", "/v1/account/config", undefined, a.credentials)).data.data, data);
  f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=? WHERE user_id=?").run(T0, a.user_id);
  assert.equal((await request(f.env, "GET", "/v1/account/config", undefined, a.credentials)).status, 403);
  assert.equal((await request(f.env, "GET", "/v1/account/export", undefined, a.credentials)).status, 403);
  assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version: 1, rev: 1, data }, a.credentials)).status, 403);
  assert.equal(f.env.DB.one("SELECT rev FROM account_configs WHERE user_id=?", a.user_id).rev, 1);
});

test("account: a Pro revocation during upload cannot commit configuration or projected notification rules", async () => {
  let armed = false, raced = false;
  const f = boot({}, { beforeBatch: async (statements) => {
    if (armed && !raced && statements.some(s => s.sql.includes("UPDATE account_configs"))) {
      raced = true; f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=?").run(T0);
    }
  }}), a = await login(f), token = tok(149);
  grantPro(f.env.DB, a.user_id);
  const native = await makeSession(f.env, a.user_id, { device_id: random(24), platform: "ios" }, "native");
  const credentials = { Authorization: `Bearer ${native.access_token}` };
  assert.equal((await request(f.env, "PUT", `/v1/devices/${token}`, nativeSettings(), credentials)).status, 200);
  const data = configFixture(); data.rules = [{ id: "r", kind: "above", value: 99, window: 0, enabled: true, seen_fired: 0, updated: Date.now() }];
  armed = true;
  assert.equal((await request(f.env, "PUT", "/v1/account/config", { schema_version: 1, rev: 0, data }, a.credentials)).status, 403);
  assert.equal(raced, true);
  assert.equal(f.env.DB.one("SELECT rev FROM account_configs WHERE user_id=?", a.user_id).rev, 0);
  assert.equal(f.env.DB.one("SELECT value FROM rules WHERE token=?", token).value, 1.2);
});
