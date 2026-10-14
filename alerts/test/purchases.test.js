import {test,afterEach} from "node:test";
import assert from "node:assert/strict";
import {setupAccount,request,login,configFixture,seedSession} from "./account-fixture.js";
import {setNow,restoreNow,T0,makeChain,signJWS,proTx} from "./helpers.js";
import {random} from "../src/auth.js";
import {sha256} from "../src/http.js";
import {accountPushAllowed} from "../src/push.js";
import {b64} from "../src/webpush.js";
import {revokeDevice} from "../src/account-lifecycle.js";
import {revokeApple} from "../src/apple.js";
import {claimPush} from "../src/account.js";

const originalFetch=globalThis.fetch,addr="prl1"+"a".repeat(38);
afterEach(()=>{globalThis.fetch=originalFetch;restoreNow();});
async function fixture(hooks={}) {
 setNow(T0);const f=setupAccount({PAY_ADDRESS:addr,VAPID_PUBLIC:"fixture",VAPID_PRIVATE:"fixture",VAPID_SUBJECT:"mailto:test@example.test"},hooks),previous=globalThis.fetch;
 f.transactions=[];
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);
  if(u.hostname==="blockbook.pearlresearch.ai") {
   if(u.pathname==="/api/")return Response.json({blockbook:{bestHeight:1000,inSync:true}});
   if(u.pathname.startsWith('/api/v2/address/'))return Response.json({transactions:f.transactions,totalPages:1});
  }
  return previous(url,init);
 };
 f.env.DB.raw.prepare("INSERT INTO kv(k,v,ts)VALUES('price',?,?)").run(JSON.stringify({usd:0.8,ts:T0}),T0);
 return f;
}
async function visitor(f) {
 const r=await request(f.env,"POST","/v1/purchase/session",{device_id:random(24)});assert.equal(r.status,200);
 return {...r.data,headers:{"X-Purchase-Key":r.data.purchase_key,"X-Account-ID":r.data.purchase_id}};
}
function confirm(f,order,confirmations=1) {
 f.transactions=[{txid:"c".repeat(64),confirmations,blockTime:T0+1,blockHeight:confirmations?1001:undefined,
 vin:[{addresses:["sender"],value:String(order.sats+100)}],vout:[{addresses:[addr],value:String(order.sats)}]}];
}
async function paid(f,v) {
 const o=await request(f.env,"POST","/v1/orders",undefined,v.headers);assert.equal(o.status,200);
 confirm(f,o.data);setNow(T0+16);
 assert.equal((await request(f.env,"GET",`/v1/orders/${o.data.id}`,undefined,v.headers)).data.status,"paid");
 return o.data;
}
async function settings() {
 const pair=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
 return {subscription:{endpoint:"https://fcm.googleapis.com/fcm/send/guest-test",keys:{p256dh:b64(await crypto.subtle.exportKey("raw",pair.publicKey)),auth:b64(new Uint8Array(16))}},
 lang:"en",rules:[{id:"r",kind:"above",value:1.2,window:0,enabled:true}],watches:[{id:"w",pool:"Kryptex",addr:"prl1p"+"q".repeat(39)+"1",label:"",after:600}]};
}
test("purchase: visitors can buy and unlock with a confirmed exact payment, with no email account or mail",async()=>{
 const f=await fixture(),v=await visitor(f);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM users").n,0);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM sessions").n,0);
 const o=await request(f.env,"POST","/v1/orders",{paid:true,txid:"known-public-transaction"},v.headers);assert.equal(o.status,200);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,false);
 confirm(f,o.data,0);
 assert.equal((await request(f.env,"GET",`/v1/orders/${o.data.id}`,undefined,v.headers)).data.status,"seen");
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,false);
 confirm(f,o.data,1);setNow(T0+16);
 assert.equal((await request(f.env,"GET",`/v1/orders/${o.data.id}`,undefined,v.headers)).data.status,"paid");
 const me=await request(f.env,"GET","/v1/me",undefined,v.headers);assert.equal(me.data.pro,true);assert.equal(me.data.pro_scope,"device");
 assert.equal((await request(f.env,"GET","/v1/purchase/session",undefined,v.headers)).data.purchase_key,undefined);
 assert.equal(f.emails.length,0);
});
test("purchase: credentials are limited to their buyer and cannot read account configuration or claim a public transaction",async()=>{
 const f=await fixture(),a=await visitor(f),b=await visitor(f),o=await paid(f,a);
 for(const path of ['/v1/account','/v1/account/config','/v1/account/export','/v1/me/config','/v1/account/entitlements'])
  assert.equal((await request(f.env,"GET",path,undefined,a.headers)).status,401,path);
 assert.equal((await request(f.env,"GET",`/v1/orders/${o.id}`,undefined,b.headers)).status,404);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,{"X-Purchase-Key":a.purchase_id})).status,401);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,{...a.headers,"X-Account-ID":b.purchase_id})).status,401);
 assert.equal((await request(f.env,"POST","/v1/purchase/session",{device_id:random(24)},{origin:"https://evil.test"})).status,403);
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},a.headers)).status,401);
 assert.equal((await request(f.env,"POST","/v1/orders",undefined,{...a.headers,origin:"https://evil.test"})).status,401);
});
test("purchase: local paid rights cannot sync a free account or rebind another account's receipt",async()=>{
 const f=await fixture(),v=await visitor(f);await paid(f,v);const a=await login(f);
 await request(f.env,"POST","/v1/purchase/associate",{},{...a.credentials,"X-Purchase-Key":v.purchase_key});
 const b=await login(f,"second@163.com"),headers={...b.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":b.user_id};
 const r=await request(f.env,"PUT","/v1/web/push",await settings(),headers);assert.equal(r.status,200);
 const data=configFixture();data.rules=[{id:"r",kind:"above",value:3,window:0,enabled:true,seen_fired:0,updated:Date.now()}];
 assert.equal((await request(f.env,"PUT","/v1/account/config",{schema_version:1,rev:0,data},headers)).status,403);
 assert.equal((await request(f.env,"GET","/v1/account/config",undefined,headers)).status,403);
 assert.equal(f.env.DB.one("SELECT value FROM rules WHERE token=?",r.data.token).value,1.2);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,b.credentials)).data.pro,false);
 assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='prl'").user_id,a.user_id);
});
test("purchase: optional accounts retain the ten browser notification limit across guest-owned channels",async()=>{
 const f=await fixture(),v=await visitor(f);await paid(f,v);const a=await login(f);
 await request(f.env,"POST","/v1/purchase/associate",{},{...a.credentials,"X-Purchase-Key":v.purchase_key});
 for(let i=0;i<11;i++){
  const token=random(),did=`notification-device-${i}`;await seedSession(f.env,token,a.user_id,did);
  const local=await visitor(f),body=await settings();body.subscription.endpoint+=`-${i}`;
  const r=await request(f.env,"PUT","/v1/web/push",body,{authorization:`Bearer ${token}`,"X-Purchase-Key":local.purchase_key,"X-Account-ID":a.user_id});
  assert.equal(r.status,i<10?200:409,`channel ${i}`);
 }
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices WHERE sync_gid=?",a.user_id).n,10);
 const access=random(),device_id='native-after-browser';await seedSession(f.env,access,a.user_id,device_id);
 assert.equal(await claimPush(f.env,{id:`fixture-${await sha256(access)}`,user_id:a.user_id,device_id},'9'.repeat(64)),false,'native registrations also count guest-owned account channels');
});
test("purchase: paid visitors register real push subscriptions and watches without signing in",async()=>{
 const f=await fixture(),v=await visitor(f),body=await settings();
 assert.equal((await request(f.env,"PUT","/v1/web/push",body,v.headers)).status,403);
 await paid(f,v);
 const r=await request(f.env,"PUT","/v1/web/push",body,v.headers);assert.equal(r.status,200);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM watches WHERE token=?",r.data.token).n,1);
 assert.equal(await accountPushAllowed(f.env.DB,r.data.token),true);
 assert.equal((await request(f.env,"GET",`/v1/devices/${r.data.token}`,undefined,v.headers)).status,200);
 assert.equal((await request(f.env,"GET",`/v1/devices/${r.data.token}`,undefined)).status,401);
});
test("purchase: optional email association grants cross-device Pro, preserves local Pro after logout and cannot rebind",async()=>{
 const f=await fixture(),v=await visitor(f);await paid(f,v);
 const a=await login(f),headers={...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id};
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},headers)).data.linked,true);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,a.credentials)).data.pro,true);
 assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='prl'").user_id,a.user_id);
 assert.equal((await request(f.env,"POST","/v1/auth/logout",{},headers)).status,200);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
 const b=await login(f,"other@163.com"),r=await request(f.env,"POST","/v1/purchase/associate",{}, {...b.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":b.user_id});
 assert.equal(r.data.conflict,true);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,b.credentials)).data.pro,false);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,{...b.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id})).status,401);
 assert.equal((await request(f.env,"PUT","/v1/web/push",await settings(),{...b.credentials,...v.headers})).status,401,'a guest request cannot silently become a new account request');
});
test("purchase: account sync reaches guest-owned notifications, revocation stops cloud rules and local purchase can resume",async()=>{
 const f=await fixture(),v=await visitor(f);await paid(f,v);const a=await login(f),headers={...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id};
 const r=await request(f.env,"PUT","/v1/web/push",await settings(),headers);assert.equal(r.status,200);
 const data=configFixture();data.rules=[{id:"r",kind:"above",value:2,window:0,enabled:true,seen_fired:0,updated:Date.now()}];
 assert.equal((await request(f.env,"PUT","/v1/account/config",{schema_version:1,rev:0,data},a.credentials)).status,200);
 assert.equal(f.env.DB.one("SELECT value FROM rules WHERE token=?",r.data.token).value,2);
 await f.env.DB.batch(revokeDevice(f.env.DB,a.user_id,a.device_id));
 assert.equal(await accountPushAllowed(f.env.DB,r.data.token),false);
 assert.equal((await request(f.env,"PUT","/v1/web/push",await settings(),headers)).status,401);
 const resumed=await request(f.env,"PUT","/v1/web/push",await settings(),v.headers);assert.equal(resumed.status,200);
 assert.equal(f.env.DB.one("SELECT sync_gid FROM devices WHERE token=?",r.data.token).sync_gid,null);
 assert.equal(await accountPushAllowed(f.env.DB,r.data.token),true);
});
test("purchase: revocation during registration cannot resurrect cloud notification rows",async()=>{
 let armed=false,raced=false,uid,did;
 const f=await fixture({before:async(sql)=>{if(armed&&!raced&&sql.includes('INSERT INTO devices')){raced=true;await f.env.DB.batch(revokeDevice(f.env.DB,uid,did));}}}),v=await visitor(f);
 await paid(f,v);const a=await login(f);uid=a.user_id;did=a.device_id;armed=true;
 const r=await request(f.env,"PUT","/v1/web/push",await settings(),{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 assert.ok(r.status>=400);assert.equal(raced,true);assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM devices").n,0);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM rules").n,0);
});
test("purchase: local copies preserve independent sources and revoked receipts stop guest delivery",async()=>{
 const f=await fixture(),v=await visitor(f);await paid(f,v);const a=await login(f),chain=await makeChain();
 f.env.APPLE_ROOT_SHA256=chain.rootSHA256;
 assert.equal((await request(f.env,"POST","/v1/account/entitlements/apple",{jws:await signJWS(chain,proTx())},a.credentials)).status,200);
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},{...a.credentials,"X-Purchase-Key":v.purchase_key})).status,200);
 const r=await request(f.env,"PUT","/v1/web/push",await settings(),v.headers);assert.equal(r.status,200);
 await revokeApple(f.env,"1000001");
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
 assert.equal(await accountPushAllowed(f.env.DB,r.data.token),true);
 f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=? WHERE source='prl'").run(T0+20);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,false);
 assert.equal(await accountPushAllowed(f.env.DB,r.data.token),false);
 assert.equal((await request(f.env,"PUT","/v1/web/push",await settings(),v.headers)).status,403);
});
