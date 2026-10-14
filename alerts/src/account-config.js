import { now, webJson as json } from "./http.js";
import { random } from "./auth.js";
import { sanitizeRule, sanitizeWindow, UPSERT_RULE } from "./rules.js";
import { sanitizeWatch, UPSERT_WATCH } from "./watch.js";
import { purchaseProSQL } from "./purchases.js";
import { accountPro, accountProSQL } from "./entitlements.js";

const enc = new TextEncoder();
const fields = ["lang", "monitors", "wallets", "rules", "window", "settingsUpdated", "calculator", "contacts", "autoRefresh", "monitorOrder", "secondary", "theme", "devices", "fleetSettings"];
const languages = ["en", "ru", "zh-Hans", "zh-Hant", "vi", "id", "es", "pt-BR", "fr", "de", "it", "tr", "ja", "ko", "hi", "th"];
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 80) => typeof v === "string" && v.length <= max;
const stamp = (v) => Number.isSafeInteger(v) && v >= 0 && v <= Date.now() + 300000;
const address = (v) => typeof v === "string" && /^(?:t)?prl1[0-9a-z]{20,100}$/.test(v);
function pick(o, keys) {
  if (!object(o) || Object.keys(o).some((k) => !keys.includes(k))) throw new Error("invalid_config");
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
}
function list(xs, max, keys, valid) {
  if (!Array.isArray(xs) || xs.length > 2000) throw new Error("config_limit");
  const ids = new Set();
  const out = xs.map((v) => {
    const x = pick(v, ["id", "updated", "deleted", ...keys]);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(x.id || "") || !stamp(x.updated) ||
        (x.deleted != null && typeof x.deleted !== "boolean") || ids.has(x.id)) throw new Error("invalid_config");
    ids.add(x.id);
    if (!x.deleted && !valid(x)) throw new Error("invalid_config");
    return x.deleted ? { id: x.id, updated: x.updated, deleted: true } : x;
  });
  if (out.filter((x) => !x.deleted).length > max) throw new Error("config_limit");
  return out;
}
export function validateConfig(value) {
  const o = pick(value, fields);
  if (enc.encode(JSON.stringify(o)).byteLength > 65536) throw new Error("config_limit");
  if (!languages.includes(o.lang) || !stamp(o.settingsUpdated)) throw new Error("invalid_config");
  if (o.autoRefresh != null && typeof o.autoRefresh !== "boolean") throw new Error("invalid_config");
  if (o.theme != null && !["system", "light", "dark"].includes(o.theme)) throw new Error("invalid_config");
  if (o.secondary != null && !/^(?:|__auto__|[A-Z]{3})$/.test(o.secondary)) throw new Error("invalid_config");
  o.monitors = list(o.monitors, 20, ["pool", "addr", "acct", "label", "alert", "after", "paused"], (x) => !!sanitizeWatch(x) &&
    typeof x.alert === "boolean" && text(x.label, 40) && (x.paused == null || typeof x.paused === "boolean"));
  o.wallets = list(o.wallets, 10, ["addr", "label"], (x) => address(x.addr) && text(x.label, 40));
  o.rules = list(o.rules, 20, ["kind", "value", "window", "enabled", "seen_fired", "repeat"], (x) => !!sanitizeRule(x) &&
    typeof x.enabled === "boolean" && Number.isSafeInteger(x.seen_fired) && x.seen_fired >= 0 && x.seen_fired <= now() + 300);
  o.contacts = list(o.contacts || [], 2000, ["name", "address", "note"], (x) => text(x.name, 100) && address(x.address) && text(x.note, 500));
  o.devices = list(o.devices || [], 2000, ["name", "gpu", "count", "rented", "hoursPerDay", "customPearl", "rentDaily", "rentCurrency", "rentFX", "sourceKey"], (x) =>
    text(x.name) && text(x.gpu) && Number.isFinite(x.count) && x.count >= 1 && x.count <= 100000 &&
    typeof x.rented === "boolean" && Number.isFinite(x.hoursPerDay) && x.hoursPerDay >= 0 && x.hoursPerDay <= 24 &&
    ["customPearl", "rentDaily", "rentFX"].every((k) => x[k] == null || Number.isFinite(x[k]) && x[k] >= 0) &&
    (x.rentCurrency == null || text(x.rentCurrency, 16)) && (x.sourceKey == null || text(x.sourceKey, 200)));
  if (o.window != null) {
    o.window = pick(o.window, ["start", "end", "tz"]);
    if (!sanitizeWindow(o.window) || !text(o.window.tz, 64)) throw new Error("invalid_config");
    try { new Intl.DateTimeFormat("en", { timeZone: o.window.tz }); } catch { throw new Error("invalid_config"); }
  }
  if (o.monitorOrder != null) {
    o.monitorOrder = pick(o.monitorOrder, ["ids", "updated"]);
    if (!stamp(o.monitorOrder.updated) || !Array.isArray(o.monitorOrder.ids) || o.monitorOrder.ids.length > 2000 ||
        o.monitorOrder.ids.some((id) => !/^[A-Za-z0-9-]{1,64}$/.test(id))) throw new Error("invalid_config");
  }
  if (o.calculator != null) {
    o.calculator = pick(o.calculator, ["gpu", "count", "th", "watts", "hardware", "hours", "fee", "electricity", "rent", "rented", "rentCoversPower", "growth", "price", "yield", "networkHash"]);
    for (const [k, v] of Object.entries(o.calculator)) {
      if (k === "gpu" ? !text(v) : ["rented", "rentCoversPower"].includes(k) ? typeof v !== "boolean" : v != null && (!Number.isFinite(v) || Math.abs(v) > (k === "networkHash" ? 1e30 : 1e15))) throw new Error("invalid_config");
    }
  }
  if (o.fleetSettings != null) {
    o.fleetSettings = pick(o.fleetSettings, ["powerBudgetW", "powerBudgetEnabled", "syncWPerTH", "selfDilution", "fxManual", "manualFX", "rentEnabled", "growthMode", "sortKey", "selectedGPU", "rents"]);
    for (const [k, v] of Object.entries(o.fleetSettings)) {
      if (k === "rents") {
        if (!object(v) || Object.keys(v).length > 2000) throw new Error("invalid_config");
        o.fleetSettings.rents = Object.fromEntries(Object.entries(v).map(([key, entry]) => {
          if (!text(key, 100) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("invalid_config");
          const rent = pick(entry, ["daily", "currency", "fx"]);
          if (!Number.isFinite(rent.daily) || rent.daily < 0 || !text(rent.currency, 16) || (rent.fx != null && (!Number.isFinite(rent.fx) || rent.fx <= 0))) throw new Error("invalid_config");
          return [key, rent];
        }));
      } else if (["powerBudgetEnabled", "selfDilution", "fxManual", "rentEnabled"].includes(k) ? typeof v !== "boolean" : k === "growthMode" ? !["auto", "manual"].includes(v) : k === "sortKey" ? !["ownNet", "rentNet", "breakEvenRent", "hash", "efficiency"].includes(v) : k === "selectedGPU" ? !text(v, 64) : !Number.isFinite(v) || v < 0 || v > 1e15) throw new Error("invalid_config");
    }
  }
  return o;
}
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function keyOf(env, version) {
  const raw = version === (env.ACCOUNT_CONFIG_KEY_VERSION || "1") ? env.ACCOUNT_CONFIG_KEY :
    JSON.parse(env.ACCOUNT_CONFIG_OLD_KEYS || "{}")[version];
  const bytes = Uint8Array.from(atob(raw || ""), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("config_key_unavailable");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(env, user, data) {
  const version = env.ACCOUNT_CONFIG_KEY_VERSION || "1", iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`${user}:${version}`) }, await keyOf(env, version), enc.encode(JSON.stringify(data)));
  return `${version}.${b64(iv)}.${b64(bytes)}`;
}
export async function decrypt(env, user, data) {
  if (!data) return null;
  const [version, iv, cipher] = data.split(".");
  const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: enc.encode(`${user}:${version}`) }, await keyOf(env, version), bytes(cipher))));
}
export async function getConfig(env, uid) {
  if (!await accountPro(env, uid)) return json({ error: "sync_requires_pro" }, 403);
  const row = await env.DB.prepare(`SELECT rev, data FROM account_configs WHERE user_id = ? AND ${accountProSQL("account_configs.user_id")}`).bind(uid).first();
  if (!row) return json({ error: "sync_requires_pro" }, 403);
  return json({ schema_version: 1, rev: row?.rev || 0, data: await decrypt(env, uid, row?.data) });
}
export async function projection(env, uid, config, commit) {
  const db = env.DB, out = [];
  let guard = `EXISTS(SELECT 1 FROM account_configs WHERE user_id = '${uid}' AND commit_id = '${commit}')
    AND EXISTS(SELECT 1 FROM users WHERE id = '${uid}' AND deleted_at IS NULL)
    AND ${accountProSQL(`'${uid}'`)}`;
  // Both values are server-generated IDs. Never interpolate configuration values.
  if (!/^u_[A-Za-z0-9_-]+$/.test(uid) || !/^[A-Za-z0-9_-]+$/.test(commit)) throw new Error("invalid_account");
  const devices = (await db.prepare(`SELECT d.token, d.oneshot FROM devices d JOIN account_devices a ON a.user_id=COALESCE(d.sync_gid,d.gid) AND a.id=COALESCE(d.sync_device_id,d.account_device_id)
    WHERE COALESCE(d.sync_gid,d.gid)=? AND a.revoked_at IS NULL AND (EXISTS(SELECT 1 FROM groups WHERE gid=? AND pro_at IS NOT NULL) OR ${purchaseProSQL("d.gid")})`)
    .bind(uid, uid).all()).results;
  const rules = config.rules.filter((r) => !r.deleted).map(sanitizeRule);
  const watches = config.monitors.filter((m) => !m.deleted && !m.paused && m.alert).map(sanitizeWatch);
  const conditional = (sql) => sql.replace(/VALUES\s*\(([^)]+)\)/, `SELECT $1 WHERE ${guard}`);
  const remove = (table, token, ids) => db.prepare(`DELETE FROM ${table} WHERE token=? ${ids.length ? `AND id NOT IN (${ids.map(() => "?").join(",")})` : ""} AND ${guard}`).bind(token, ...ids);
  for (const d of devices) {
    const baseGuard = guard;
    if (!/^[a-f0-9]{64,200}$/.test(d.token)) throw new Error("invalid_device");
    guard = `${baseGuard} AND EXISTS(SELECT 1 FROM devices d JOIN account_devices a ON a.user_id=COALESCE(d.sync_gid,d.gid) AND a.id=COALESCE(d.sync_device_id,d.account_device_id)
      JOIN account_push_claims p ON p.token=d.token WHERE d.token='${d.token}' AND a.revoked_at IS NULL AND p.revoked_at IS NULL
      AND (EXISTS(SELECT 1 FROM groups WHERE gid='${uid}' AND pro_at IS NOT NULL) OR ${purchaseProSQL("d.gid")}))`;
    const deviceGuard = `${guard} AND EXISTS(SELECT 1 FROM account_devices WHERE user_id='${uid}' AND id=COALESCE(devices.sync_device_id,devices.account_device_id) AND revoked_at IS NULL)`;
    out.push(db.prepare(`UPDATE devices SET lang=?, win_start=?, win_end=?, tz=? WHERE token=? AND ${deviceGuard}`)
      .bind(config.lang, config.window?.start ?? null, config.window?.end ?? null, config.window?.tz ?? null, d.token),
      remove("rules", d.token, rules.map((r) => r.id)),
      ...rules.map((r) => db.prepare(conditional(UPSERT_RULE)).bind(d.token, r.id, r.kind, r.value, r.window, r.enabled, d.oneshot, r.seen_fired, r.repeating)),
      db.prepare(`DELETE FROM deferred WHERE token=? AND ${guard} AND NOT EXISTS(SELECT 1 FROM rules r WHERE r.token=deferred.token AND r.id=deferred.rule_id AND r.kind=deferred.kind AND r.value=deferred.value AND r.window=deferred.window)`).bind(d.token),
      remove("watches", d.token, watches.map((w) => w.id)),
      ...watches.map((w) => db.prepare(conditional(UPSERT_WATCH)).bind(d.token, w.id, w.pool, w.addr, w.label, w.after)),
      ...watches.map((w) => db.prepare(`INSERT OR IGNORE INTO miners(pool, addr) SELECT ?, ? WHERE ${guard}`).bind(w.pool, w.addr)));
    guard = baseGuard;
  }
  return out;
}
export async function putConfig(env, uid, body, session) {
  if (!await accountPro(env, uid)) return json({ error: "sync_requires_pro" }, 403);
  if (env.ACCOUNT_CONFIG_WRITE_ENABLED === "0") return json({ error: "sync_unavailable" }, 503);
  if (body.schema_version !== 1 || !Number.isSafeInteger(body.rev) || body.rev < 0) return json({ error: "invalid_config" }, 400);
  let data;
  try { data = validateConfig(body.data); } catch (e) { return json({ error: e.message }, e.message === "config_limit" ? 413 : 400); }
  const commit = random(24), encrypted = await encrypt(env, uid, data);
  const writes = await projection(env, uid, data, commit);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE account_configs SET data=?, rev=rev+1, commit_id=?, updated_at=? WHERE user_id=? AND rev=?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
      AND ${accountProSQL("account_configs.user_id")}
      AND EXISTS(SELECT 1 FROM sessions s JOIN account_devices d ON d.user_id=s.user_id AND d.id=s.device_id
        WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND d.revoked_at IS NULL)`)
      .bind(encrypted, commit, now(), uid, body.rev, uid, session?.id || "", uid), ...writes,
  ]);
  if (result[0].meta.changes) return json({ schema_version: 1, rev: body.rev + 1 });
  return await accountPro(env, uid) ? json({ error: "conflict" }, 409) : json({ error: "sync_requires_pro" }, 403);
}
