import { webJson as json, now } from "./http.js";
import { publicOrder, paymentSettings } from "./orders.js";
import { configured as webpushConfigured } from "./webpush.js";
export async function me(env, gid) {
  const t = now(),
    db = env.DB;
  const [g, o] = await Promise.all([
    db
      .prepare("SELECT pro_at, pro_src FROM groups WHERE gid = ?")
      .bind(gid)
      .first(),
    db
      .prepare(
        "SELECT * FROM orders WHERE gid = ? AND (expires_at > ? OR status IN ('seen', 'paid')) ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .bind(gid, t)
      .first(),
  ]);
  return json({
    pro: g?.pro_at != null,
    pro_src: g?.pro_src || null,
    pro_at: g?.pro_at ?? null,
    order: o ? publicOrder(env, o) : null,
    pay: paymentSettings(env),
    vapid_key: webpushConfigured(env) ? env.VAPID_PUBLIC : null,
  });
}
