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
import {checkPayments} from "../src/orders.js";

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
test("purchase: checkout grants the signed-in account on background confirmation without the payment page",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);
 const headers={...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id};
 const o=await request(f.env,"POST","/v1/orders",undefined,headers);assert.equal(o.status,200);
 await f.env.DB.batch(revokeDevice(f.env.DB,a.user_id,a.device_id));
 confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
 assert.deepEqual(f.env.DB.one("SELECT user_id,product,platform,granted_at,revoked_at FROM entitlements WHERE source='prl'"),
  {user_id:a.user_id,product:"pro",platform:"web",granted_at:T0+16,revoked_at:null});
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM purchase_licenses WHERE visitor_id=?",v.purchase_id).n,1);
 setNow(T0+61);
 const otherDevice=await login(f,"person@qq.com");
 assert.equal((await request(f.env,"GET","/v1/account",undefined,otherDevice.credentials)).data.pro,true);
 assert.equal((await request(f.env,"GET",`/v1/orders/${o.data.id}`,undefined,otherDevice.credentials)).status,200);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
});
test("purchase: an account associated while an order is pending receives later confirmation without another callback",async()=>{
 const f=await fixture(),v=await visitor(f);
 const o=await request(f.env,"POST","/v1/orders",undefined,v.headers);assert.equal(o.status,200);
 const a=await login(f),headers={...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id};
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},headers)).status,200);
 confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,true);
});
test("purchase: unconfirmed payments do not grant account Pro and repeated confirmations cannot duplicate or revive rights",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 confirm(f,o.data,0);await checkPayments(f.env);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n,0);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,false);
 confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements WHERE source='prl' AND user_id=?",a.user_id).n,1);
 setNow(T0+32);await checkPayments(f.env);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements WHERE source='prl'").n,1);
 f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=? WHERE source='prl'").run(T0+32);
 setNow(T0+48);await checkPayments(f.env);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,false);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,false);
});
test("purchase: switching accounts before confirmation cannot take the checkout account's order",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 const b=await login(f,"other@fixture.test"),headers={...b.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":b.user_id};
 const linked=await request(f.env,"POST","/v1/purchase/associate",{},headers);assert.equal(linked.data.conflict,true);
 const checkout=await request(f.env,"POST","/v1/orders",undefined,headers);
 assert.equal(checkout.status,409);assert.equal(checkout.data.error,"purchase_already_linked");
 confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,true);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,b.credentials)).data.pro,false);
 assert.equal((await request(f.env,"GET",`/v1/orders/${o.data.id}`,undefined,b.credentials)).status,404);
});
test("purchase: deletion before confirmation preserves the device receipt without granting or transferring account rights",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 f.env.DB.raw.prepare("UPDATE users SET deleted_at=? WHERE id=?").run(T0+1,a.user_id);
 confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n,0);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
 const b=await login(f,"other@fixture.test"),headers={...b.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":b.user_id};
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},headers)).data.conflict,true);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,b.credentials)).data.pro,false);
});
test("purchase: revocation during checkout cannot persist a stale account binding",async()=>{
 let armed=false,raced=false,a;
 const f=await fixture({before:async(sql)=>{
  if(armed&&!raced&&sql.includes("INSERT INTO orders")){
   raced=true;await f.env.DB.batch(revokeDevice(f.env.DB,a.user_id,a.device_id));
  }
 }}),v=await visitor(f);a=await login(f);armed=true;
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 assert.equal(raced,true);assert.equal(o.status,401);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM orders").n,0);
});
test("purchase: a guest cannot select an account by supplying its identifier in the checkout body",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);
 const o=await request(f.env,"POST","/v1/orders",{account_id:a.user_id,user_id:a.user_id},v.headers);assert.equal(o.status,200);
 confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,false);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
});
test("purchase: an account status read repairs a legacy paid order when both credentials are present",async()=>{
 const f=await fixture(),v=await visitor(f);await paid(f,v);const a=await login(f);
 const me=await request(f.env,"GET","/v1/me",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 assert.equal(me.data.pro,true);assert.equal(me.data.pro_scope,"account");
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,true);
});
test("purchase: a failed entitlement write rolls back the payment settlement for a later retry",async()=>{
 let fail=false;
 const f=await fixture({before:async(sql)=>{if(fail&&sql.includes("INSERT OR IGNORE INTO entitlements"))throw new Error("settlement failure");}});
 const v=await visitor(f),a=await login(f);
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 confirm(f,o.data);setNow(T0+16);fail=true;
 await assert.rejects(checkPayments(f.env),/settlement failure/);
 assert.equal(f.env.DB.one("SELECT status FROM orders WHERE id=?",o.data.id).status,"pending");
 assert.equal(f.env.DB.one("SELECT order_id FROM payments").order_id,null);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements").n,0);
 assert.equal(f.env.DB.one("SELECT pro_at FROM groups WHERE gid=?",v.purchase_id).pro_at,null);
 fail=false;setNow(T0+32);await checkPayments(f.env);
 assert.equal(f.env.DB.one("SELECT status FROM orders WHERE id=?",o.data.id).status,"paid");
 assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='prl'").user_id,a.user_id);
});
test("purchase: manual settlement grants the recorded checkout account through the same entitlement ledger",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);f.env.ADMIN_TOKEN="fixture-admin";
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 const grant=await request(f.env,"POST","/v1/admin/grant",{order_id:o.data.id,txid:"d".repeat(64)},{Authorization:"Bearer fixture-admin"});
 assert.equal(grant.status,200);
 assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='prl'")?.user_id,a.user_id);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,true);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
});
for(const phase of ["lookup","insert"]) {
 test(`purchase: signed-in checkout claims a guest order inserted concurrently at ${phase}`,async()=>{
  let armed=false,raced=false,f,v;
  f=await fixture({before:async(sql)=>{
   const target=phase==="lookup"?sql.startsWith("SELECT * FROM orders WHERE gid = ? AND (status = 'seen'"):sql.includes("INSERT INTO orders");
   if(armed&&!raced&&target){
    raced=true;
    f.env.DB.raw.prepare("INSERT OR IGNORE INTO groups(gid,created_at,seen_at) VALUES(?,?,?)").run(v.purchase_id,T0,T0);
    f.env.DB.raw.prepare("INSERT INTO orders(id,gid,usd,rate,sats,created_at,expires_at,start_height) VALUES('racing-guest-order',?,5,0.8,625100000,?,?,1000)").run(v.purchase_id,T0,T0+1800);
   }
  }});v=await visitor(f);const a=await login(f);armed=true;
  const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
  assert.equal(raced,true);assert.equal(o.status,200);assert.equal(o.data.id,"racing-guest-order");
  confirm(f,o.data);setNow(T0+16);await checkPayments(f.env);
  assert.equal(f.env.DB.one("SELECT user_id FROM entitlements WHERE source='prl'")?.user_id,a.user_id);
 });
}
test("purchase: manual settlement without a transaction ID is account-wide, idempotent and cannot revive a revoked grant",async()=>{
 const f=await fixture(),v=await visitor(f),a=await login(f);f.env.ADMIN_TOKEN="fixture-admin";
 const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
 const settle=()=>request(f.env,"POST","/v1/admin/grant",{order_id:o.data.id},{Authorization:"Bearer fixture-admin"});
 assert.equal((await settle()).status,200);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,true);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
 setNow(T0+16);assert.equal((await settle()).status,200);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements WHERE user_id=?",a.user_id).n,1);
 const grant=f.env.DB.one("SELECT source,ref,granted_at FROM entitlements WHERE user_id=?",a.user_id);
 assert.deepEqual(grant,{source:"admin",ref:`order:${o.data.id}`,granted_at:T0});
 f.env.DB.raw.prepare("UPDATE entitlements SET revoked_at=? WHERE source='admin' AND ref=?").run(T0+16,grant.ref);
 assert.equal((await settle()).status,200);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,false);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,false);
});
test("purchase: a transaction-less manual guest receipt can later bind once to a verified account",async()=>{
 const f=await fixture(),v=await visitor(f);f.env.ADMIN_TOKEN="fixture-admin";
 const o=await request(f.env,"POST","/v1/orders",undefined,v.headers);
 assert.equal((await request(f.env,"POST","/v1/admin/grant",{order_id:o.data.id},{Authorization:"Bearer fixture-admin"})).status,200);
 assert.equal((await request(f.env,"GET","/v1/me",undefined,v.headers)).data.pro,true);
 const a=await login(f),headers={...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id};
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},headers)).data.linked,true);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,a.credentials)).data.pro,true);
 const b=await login(f,"other@fixture.test");
 assert.equal((await request(f.env,"POST","/v1/purchase/associate",{},{...b.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":b.user_id})).data.conflict,true);
 assert.equal((await request(f.env,"GET","/v1/account",undefined,b.credentials)).data.pro,false);
});
test("purchase: five account payments settle within the D1 query budget including batch statements",async()=>{
 let measuring=false,queries=0;
 const f=await fixture({before:async()=>{if(measuring)queries++;}}),a=await login(f),orders=[];
 for(let i=0;i<5;i++){
  const v=await visitor(f);
  const o=await request(f.env,"POST","/v1/orders",undefined,{...a.credentials,"X-Purchase-Key":v.purchase_key,"X-Account-ID":a.user_id});
  assert.equal(o.status,200);orders.push(o.data);
 }
 f.transactions=orders.map((o,i)=>({txid:(i+1).toString(16).padStart(64,"0"),confirmations:1,blockTime:T0+1,blockHeight:1001,
  vin:[{addresses:["sender"],value:String(o.sats+100)}],vout:[{addresses:[addr],value:String(o.sats)}]}));
 setNow(T0+16);measuring=true;await checkPayments(f.env);measuring=false;
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM entitlements WHERE user_id=? AND source='prl'",a.user_id).n,5);
 assert.equal(f.env.DB.one("SELECT COUNT(*) n FROM purchase_licenses").n,5);
 assert.ok(queries<=45,`${queries} D1 queries including all batch statements`);
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
