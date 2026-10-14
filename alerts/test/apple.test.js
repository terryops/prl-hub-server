import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeChain, signJWS, proTx, setNow, restoreNow, T0 } from "./helpers.js";
import { setupAccount, login, request, challenge } from "./account-fixture.js";
const original = fetch;
afterEach(() => { globalThis.fetch = original; restoreNow(); });
const chain = await makeChain();
const boot = (extra = {}) => { setNow(T0); return setupAccount({ APPLE_ROOT_SHA256: chain.rootSHA256, ...extra }); };
const link = async (f, a, tx = {}, proof) => request(f.env, "POST", "/v1/account/entitlements/apple", { jws: await signJWS(chain, proTx(tx)), proof }, a.credentials);
const notification = async (f, ref = "1000001", type = "REFUND", forged = false) => {
  const payload = { notificationType: type, notificationUUID: `${ref}-${type}`, data: { bundleId: "com.prl.wizard", signedTransactionInfo: await signJWS(chain, proTx({ originalTransactionId: ref })) } };
  return request(f.env,"POST","/v1/asn/asn-secret",{ signedPayload: forged ? `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.forged` : await signJWS(chain,payload) });
};
test("apple accounts: authenticated, pinned receipt validation and sandbox gate", async () => {
  const f = boot(), a = await login(f);
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{})).status,401);
  for (const tx of [{bundleId:"wrong"},{productId:"wrong"},{revocationDate:0},{environment:"Sandbox"},{environment:"Xcode"},{originalTransactionId:null}]) assert.equal((await link(f,a,tx)).status,400);
  assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws:"forged"},a.credentials)).status,400);
  f.env.APPLE_SANDBOX_OK="1"; assert.equal((await link(f,a,{environment:"Sandbox"})).data.pro,true);
});
test("apple accounts: purchase has one owner and repeated binding is idempotent", async () => {
  const f=boot(),a=await login(f),b=await login(f,"other@163.com");
  assert.equal((await link(f,a)).status,200); assert.equal((await link(f,a)).status,200);
  assert.equal((await link(f,b)).data.error,"purchase_already_linked");
  assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n,1);
});
test("apple accounts: concurrent binding grants one owner", async () => {
  const f=boot(),users=await Promise.all([1,2,3].map(i=>login(f,`person${i}@qq.com`)));
  const out=await Promise.all(users.map(a=>link(f,a)));
  assert.equal(out.filter(r=>r.status===200).length,1); assert.equal(out.filter(r=>r.status===409).length,2);
});
test("apple accounts: forged refunds do nothing, signed refunds stop only unsupported Web notifications", async () => {
  for(const type of ["REFUND","REVOKE"]){
    const f=boot(),a=await login(f); await link(f,a);
    f.env.DB.raw.prepare("INSERT INTO devices(token,env,topic,updated_at,chan,gid) VALUES('web','production','web',?,'webpush',?)").run(T0,a.user_id);
    f.env.DB.raw.prepare("INSERT INTO webpush VALUES('web','sample','sample','sample')").run();
    await notification(f,"1000001",type,true);
    assert.equal((await request(f.env,"GET","/v1/account/entitlements",undefined,a.credentials)).data.pro,true);
    await notification(f,"1000001",type);
    assert.equal((await request(f.env,"GET","/v1/account/entitlements",undefined,a.credentials)).data.pro,false);
    assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM webpush").n,0);
    assert.equal((await link(f,a)).status,400);
  }
});
test("apple accounts: an early signed refund prevents subsequent receipt replay", async () => {
  const f=boot(),a=await login(f); await notification(f);
  assert.equal((await link(f,a)).status,400); assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n,0);
});
test("apple accounts: refund keeps independent confirmed PRL entitlement", async () => {
  const f=boot(),a=await login(f); await link(f,a);
  f.env.DB.raw.prepare("INSERT INTO entitlements VALUES('prl','confirmed-payment',?,'pro','web',?,NULL)").run(a.user_id,T0-1);
  await notification(f);
  assert.equal((await request(f.env,"GET","/v1/account/entitlements",undefined,a.credentials)).data.pro,true);
});
test("apple accounts: new binding requires fresh login or purpose-specific email proof", async () => {
  const f=boot(),a=await login(f);setNow(T0+301);
  assert.equal((await link(f,a)).data.error,"verification_required");
  const proof=await challenge(f,"person@qq.com","purchase",a.credentials);
  assert.equal((await link(f,a,{},proof)).status,200);
  setNow(T0+10000);assert.equal((await link(f,a)).status,200,"a bound receipt needs no new proof");
});
