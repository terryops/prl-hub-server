import { authenticate, random, readBody } from "./auth.js";
import { sha256, now, webJson as json } from "./http.js";
import { syncPaid, recalculate } from "./entitlements.js";
import { me } from "./groups.js";

const KEY = /^[A-Za-z0-9_-]{43}$/;
const DEVICE = /^[A-Za-z0-9_-]{16,80}$/;
export const purchaseProSQL = (id) => `(EXISTS(SELECT 1 FROM orders o WHERE o.gid=${id} AND o.status='paid' AND o.txid IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM entitlements e WHERE e.source='prl' AND e.ref=o.txid AND e.revoked_at IS NOT NULL))
  OR EXISTS(SELECT 1 FROM purchase_licenses l JOIN entitlements e ON e.source=l.source AND e.ref=l.ref
    WHERE l.visitor_id=${id} AND e.product='pro' AND e.platform='web' AND e.revoked_at IS NULL))`;

export async function authenticatePurchase(req, env) {
  if (!["GET","HEAD"].includes(req.method) && req.headers.get("origin") !== (env.ACCOUNT_ORIGIN || new URL(req.url).origin)) return null;
  const key = req.headers.get("x-purchase-key");
  if (!KEY.test(key || "")) return null;
  const id = "g_" + await sha256(key);
  const v = await env.DB.prepare("SELECT * FROM purchase_visitors WHERE id=? AND revoked_at IS NULL").bind(id).first();
  if (v && v.seen_at < now()-3600) await env.DB.prepare("UPDATE purchase_visitors SET seen_at=? WHERE id=? AND revoked_at IS NULL").bind(now(),id).run();
  return v ? { id, user_id:id, device_id:v.device_id, client:"purchase" } : null;
}
export async function buyerContexts(req, env) {
  // Compare the expected identity once both proofs are known; otherwise a valid
  // new account could be mistaken for a guest request from a previous view.
  const [account, purchase] = await Promise.all([authenticate(req, env, false), authenticatePurchase(req, env)]);
  const expected = req.headers.get("x-account-id");
  if (expected && account && expected !== account.user_id) return { account:null, purchase:null };
  if (expected && expected !== account?.user_id && expected !== purchase?.user_id) return { account:null, purchase:null };
  return { account, purchase };
}
export async function purchaseRights(env, id) {
  return (await env.DB.prepare(`SELECT 'prl' AS source, txid AS ref, paid_at AS granted_at FROM orders o
    WHERE gid=? AND status='paid' AND txid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entitlements e WHERE e.source='prl' AND e.ref=o.txid AND e.revoked_at IS NOT NULL)
    UNION SELECT e.source,e.ref,e.granted_at FROM purchase_licenses l JOIN entitlements e ON e.source=l.source AND e.ref=l.ref
    WHERE l.visitor_id=? AND e.product='pro' AND e.platform='web' AND e.revoked_at IS NULL ORDER BY granted_at,source`).bind(id,id).all()).results;
}
export async function refreshPurchase(env, purchase) {
  const rights = await purchaseRights(env,purchase.user_id), first=rights[0], t=now();
  if (first) await env.DB.prepare(`INSERT INTO groups(gid,created_at,seen_at,pro_at,pro_src,pro_ref)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM purchase_visitors WHERE id=? AND revoked_at IS NULL)
    ON CONFLICT(gid) DO UPDATE SET pro_at=excluded.pro_at,pro_src=excluded.pro_src,pro_ref=excluded.pro_ref`)
    .bind(purchase.user_id,t,t,first.granted_at,first.source,first.ref,purchase.user_id).run();
  else await env.DB.prepare("UPDATE groups SET pro_at=NULL,pro_src=NULL,pro_ref=NULL WHERE gid=?").bind(purchase.user_id).run();
  return rights.length > 0;
}
async function purchaseProfile(env, purchase, account=null) {
  await refreshPurchase(env,purchase);
  const view=await (await me(env,purchase.user_id)).json();
  const linked=await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o JOIN entitlements e ON e.source='prl' AND e.ref=o.txid
    WHERE o.gid=? AND o.status='paid' AND e.revoked_at IS NULL`).bind(purchase.user_id).first();
  return {...view,purchase_id:purchase.user_id,linked:linked.n>0};
}
export async function buyerMe(env,{account,purchase}) {
  if (account) await syncPaid(env,account.user_id);
  const local=purchase?await purchaseProfile(env,purchase,account):null;
  const base=account?await (await me(env,account.user_id)).json():local;
  return json({...base,pro:!!(base?.pro||local?.pro),pro_scope:base?.pro&&account?"account":"device",
    ...(base?.pro?{}:local?.pro?{pro_at:local.pro_at,pro_src:local.pro_src}:{}),
    order:local?.order||base?.order||null,purchase:local?{id:purchase.user_id,pro:local.pro,linked:local.linked}:null});
}
export async function associatePurchase(env, account, purchase) {
  if (!account || !purchase) return {linked:false};
  const db=env.DB,uid=account.user_id,id=purchase.user_id;
  await syncPaid(env,uid);
  const guard=`EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN account_devices a ON a.user_id=s.user_id AND a.id=s.device_id WHERE s.id=? AND s.user_id=?
    AND s.revoked_at IS NULL AND u.deleted_at IS NULL AND a.revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM purchase_visitors WHERE id=? AND revoked_at IS NULL)`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO entitlements(source,ref,user_id,product,platform,granted_at)
      SELECT 'prl',o.txid,?,'pro','web',o.paid_at FROM orders o WHERE o.gid=? AND o.status='paid' AND o.txid IS NOT NULL AND ${guard}`)
      .bind(uid,id,account.id,uid,id),
    recalculate(db,uid),
    db.prepare(`INSERT OR IGNORE INTO purchase_licenses(visitor_id,source,ref,granted_at)
      SELECT ?,e.source,e.ref,e.granted_at FROM entitlements e WHERE e.user_id=? AND e.product='pro'
      AND e.platform='web' AND e.revoked_at IS NULL AND ${guard}`).bind(id,uid,account.id,uid,id),
  ]);
  const conflict=await db.prepare(`SELECT 1 FROM orders o JOIN entitlements e ON e.source='prl' AND e.ref=o.txid
    WHERE o.gid=? AND o.status='paid' AND e.revoked_at IS NULL AND e.user_id<>? LIMIT 1`).bind(id,uid).first();
  await refreshPurchase(env,purchase);
  return {linked:!conflict,conflict:!!conflict};
}
export async function purchaseRoutes(req,env) {
  const path=new URL(req.url).pathname;
  if (path!=="/v1/purchase/session" && path!=="/v1/purchase/associate") return null;
  const purchase=await authenticatePurchase(req,env);
  if (req.method==="GET"&&path==="/v1/purchase/session") return purchase?json(await purchaseProfile(env,purchase)):json({error:"unauthorized"},401);
  if (req.method!=="POST") return json({error:"not_found"},404);
  if (req.headers.get("origin")!==(env.ACCOUNT_ORIGIN||new URL(req.url).origin)) return json({error:"bad_origin"},403);
  if (path==="/v1/purchase/associate") {
    const account=await authenticate(req,env);
    if(!account||!purchase) return json({error:"unauthorized"},401);
    return json(await associatePurchase(env,account,purchase));
  }
  if(purchase) return json(await purchaseProfile(env,purchase));
  if(env.RL_NEW&&!(await env.RL_NEW.limit({key:req.headers.get("cf-connecting-ip")||"unknown"})).success) return json({error:"rate_limited"},429);
  let body;try {body=await readBody(req);}catch{return json({error:"bad_body"},400);}
  if(!DEVICE.test(body.device_id||"")) return json({error:"bad_device"},400);
  const key=random(),id="g_"+await sha256(key),t=now();
  await env.DB.prepare("INSERT INTO purchase_visitors(id,device_id,created_at,seen_at) VALUES(?,?,?,?)").bind(id,body.device_id,t,t).run();
  const actor={id,user_id:id,device_id:body.device_id,client:"purchase"};
  return json({...await purchaseProfile(env,actor),purchase_key:key});
}
export async function claimPurchasePush(env,session,token,account=null) {
  const db=env.DB,t=now();
  // An existing account channel can move to this browser's credential only with
  // both its current account session and the local purchase credential.
  if(account) await db.batch([
    db.prepare(`UPDATE account_push_claims SET user_id=?,device_id=? WHERE token=? AND user_id=? AND device_id=?
      AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM account_devices WHERE user_id=? AND id=? AND revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM purchase_visitors WHERE id=? AND revoked_at IS NULL)`)
      .bind(session.user_id,session.device_id,token,account.user_id,account.device_id,account.id,account.user_id,account.device_id,session.id),
    db.prepare(`UPDATE devices SET gid=?,account_device_id=? WHERE token=? AND chan='webpush'
      AND EXISTS(SELECT 1 FROM account_push_claims WHERE token=? AND user_id=? AND device_id=? AND revoked_at IS NULL)`)
      .bind(session.user_id,session.device_id,token,token,session.user_id,session.device_id),
  ]);
  const out=await db.prepare(`INSERT INTO account_push_claims(token,user_id,device_id,kind)
    SELECT ?,?,?,'notification' WHERE EXISTS(SELECT 1 FROM purchase_visitors WHERE id=? AND revoked_at IS NULL)
    ON CONFLICT(token) DO UPDATE SET revoked_at=NULL WHERE account_push_claims.user_id=excluded.user_id AND account_push_claims.device_id=excluded.device_id
    RETURNING token`).bind(token,session.user_id,session.device_id,session.id).first();
  if(!out)return false;
  const old="SELECT token FROM account_push_claims WHERE user_id=? AND token<>? AND revoked_at IS NULL";
  await db.batch([
    ...["rules","deferred","watches","webpush","devices"].map(table=>db.prepare(`DELETE FROM ${table} WHERE token IN(${old})`).bind(session.user_id,token)),
    db.prepare(`UPDATE account_push_claims SET revoked_at=? WHERE token IN(${old})`).bind(t,session.user_id,token),
  ]);
  return true;
}
export function prunePurchases(db,t) {
  return db.prepare(`DELETE FROM purchase_visitors WHERE seen_at<?
    AND NOT EXISTS(SELECT 1 FROM orders WHERE gid=purchase_visitors.id AND (status IN('paid','seen') OR created_at>?))
    AND NOT EXISTS(SELECT 1 FROM purchase_licenses WHERE visitor_id=purchase_visitors.id)
    AND NOT EXISTS(SELECT 1 FROM devices WHERE gid=purchase_visitors.id)`).bind(t-30*86400,t-7*86400);
}
