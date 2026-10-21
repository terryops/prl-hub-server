import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, sanitizeRule, mergeRule, UPSERT_RULE, pctChange, sanitizeWindow, windowOpen, localHM, REACH_BELOW, REACH_ABOVE } from "../src/rules.js";
import { makeD1 } from "./helpers.js";
import { combine, median, parseSafeTrade } from "../src/price.js";
import { readdirSync } from "node:fs";
import { fmtUSD, payloadFor, deferredPayloadFor, LANGS } from "../src/i18n.js";
import { signJWT } from "../src/apns.js";
import { jwsPayload, parseNotification } from "../src/sales.js";

const ctx = (usd, now = 100000, change = {}) => ({ usd, now, change: { 3600: null, 86400: null, ...change } });

test("above: fires once, re-arms only after a 2% pullback", () => {
  let r = { kind: "above", value: 0.9, armed: 1, last_fired: null };
  assert.deepEqual(evaluate(r, ctx(0.89)), { fire: false, armed: true });
  assert.deepEqual(evaluate(r, ctx(0.9)), { fire: true, armed: false });
  r = { ...r, armed: 0, last_fired: 100000 };
  assert.equal(evaluate(r, ctx(0.95, 100060)).fire, false);           // still above: no repeat
  assert.equal(evaluate(r, ctx(0.885, 100060)).armed, false);         // -1.7%: not yet
  assert.equal(evaluate(r, ctx(0.88, 100060)).armed, true);           // -2.2%: re-armed
});

test("above: re-armed but inside the 30 min cooldown waits, then fires", () => {
  const r = { kind: "above", value: 0.9, armed: 1, last_fired: 100000 };
  assert.deepEqual(evaluate(r, ctx(0.91, 100000 + 600)), { fire: false, armed: true });
  assert.deepEqual(evaluate(r, ctx(0.91, 100000 + 1800)), { fire: true, armed: false });
});

test("below mirrors above", () => {
  const r = { kind: "below", value: 0.7, armed: 1, last_fired: null };
  assert.equal(evaluate(r, ctx(0.71)).fire, false);
  assert.equal(evaluate(r, ctx(0.7)).fire, true);
  const d = { ...r, armed: 0, last_fired: 1 };
  assert.equal(evaluate(d, ctx(0.71)).armed, false);
  assert.equal(evaluate(d, ctx(0.715)).armed, true);
});

test("reach: a new rule takes the side of the price before this tick, then fires either way", () => {
  const r = { kind: "reach", value: 0.6, armed: 1, last_fired: null };
  const at = (usd, prev, now = 100000) => evaluate(r, { ...ctx(usd, now), prev });
  assert.deepEqual(at(0.58, 0.57), { fire: false, armed: REACH_BELOW, change: 1 });
  assert.deepEqual(at(0.62, 0.63), { fire: false, armed: REACH_ABOVE, change: -1 });
  assert.deepEqual(at(0.61, 0.59), { fire: true, armed: 0, change: 1 });       // crossed up since the tick before
  assert.deepEqual(at(0.59, 0.61), { fire: true, armed: 0, change: -1 });      // crossed down
  assert.deepEqual(at(0.6, 0.62), { fire: true, armed: 0, change: -1 });       // touching counts
  assert.deepEqual(at(0.6, 0.6), { fire: true, armed: 0, change: 1 });         // already at the target
  assert.deepEqual(at(0.62, null), { fire: false, armed: REACH_ABOVE, change: -1 }); // no earlier price: this one
});

test("reach: armed on a side, it waits for that side's crossing; re-arms on whichever side it leaves to", () => {
  const below = { kind: "reach", value: 0.6, armed: REACH_BELOW, last_fired: null };
  assert.equal(evaluate(below, { ...ctx(0.59), prev: 0.62 }).fire, false);      // still below: prev doesn't matter
  assert.deepEqual(evaluate(below, ctx(0.6)), { fire: true, armed: 0, change: 1 });
  const above = { ...below, armed: REACH_ABOVE };
  assert.equal(evaluate(above, ctx(0.61)).fire, false);
  assert.deepEqual(evaluate(above, ctx(0.55)), { fire: true, armed: 0, change: -1 });
  // Fired: re-arms only 2% away, on the side it went to.
  const d = { ...below, armed: 0, last_fired: 100000 };
  assert.deepEqual(evaluate(d, ctx(0.61, 100060)), { fire: false, armed: 0 });
  assert.deepEqual(evaluate(d, ctx(0.59, 100060)), { fire: false, armed: 0 });
  assert.deepEqual(evaluate(d, ctx(0.613, 100060)), { fire: false, armed: REACH_ABOVE });
  assert.deepEqual(evaluate(d, ctx(0.587, 100060)), { fire: false, armed: REACH_BELOW });
  // Re-armed inside the 30 min cooldown: holds, and fires once cooled if still across.
  const again = { ...above, last_fired: 100000 };
  assert.deepEqual(evaluate(again, ctx(0.6, 100600)), { fire: false, armed: REACH_ABOVE, change: -1 });
  assert.deepEqual(evaluate(again, ctx(0.6, 101800)), { fire: true, armed: 0, change: -1 });
});

test("move: |change| over its own window, both directions", () => {
  const r = { kind: "move", value: 10, window: 3600, armed: 1, last_fired: null };
  assert.equal(evaluate(r, ctx(1, 100000, { 3600: 9.9 })).fire, false);
  assert.equal(evaluate(r, ctx(1, 100000, { 3600: -10.5 })).fire, true);
  assert.equal(evaluate(r, ctx(1, 100000, { 86400: 50 })).fire, false); // other window
  assert.equal(evaluate(r, ctx(1, 100000)).fire, false);                // no history
  const d = { ...r, armed: 0, last_fired: 100000 };
  assert.equal(evaluate(d, ctx(1, 100100, { 3600: 6 })).armed, false);
  assert.equal(evaluate(d, ctx(1, 100100, { 3600: 4.9 })).armed, true);
});

test("move: 5-min window, with a 15-min floor on the cooldown", () => {
  const r = { kind: "move", value: 3, window: 300, armed: 1, last_fired: null };
  assert.equal(evaluate(r, ctx(1, 100000, { 300: 3.2 })).fire, true);
  assert.equal(evaluate(r, ctx(1, 100000, { 3600: 9 })).fire, false);        // other window
  const d = { ...r, armed: 1, last_fired: 100000 };                          // re-armed quickly…
  assert.equal(evaluate(d, ctx(1, 100000 + 600, { 300: -4 })).fire, false);  // …but 10 min < 15 min floor
  assert.equal(evaluate(d, ctx(1, 100000 + 900, { 300: -4 })).fire, true);
});

test("mergeRule: one-shot clients keep a fired rule off until they have seen the firing", () => {
  const fired = { kind: "above", value: 1.5, window: 0, enabled: 0, armed: 0, last_fired: 1000 };
  const resend = { kind: "above", value: 1.5, window: 0, enabled: 1, seen_fired: 0 };
  // Re-sync from an app that hasn't read the firing back yet: stays off.
  assert.deepEqual(mergeRule(fired, resend, true), { enabled: 0, armed: 0, last_fired: 1000 });
  assert.equal(mergeRule(fired, { ...resend, seen_fired: 900 }, true).enabled, 0);   // saw an older one
  // It has seen this firing (showed the rule off) and the user switched it on: on, still disarmed.
  assert.deepEqual(mergeRule(fired, { ...resend, seen_fired: 1000 }, true), { enabled: 1, armed: 0, last_fired: 1000 });
  // Legacy clients (no oneshot): their toggle wins, as before.
  assert.equal(mergeRule(fired, resend, false).enabled, 1);
  // A rule the user turned off without it ever firing turns back on normally.
  assert.equal(mergeRule({ ...fired, last_fired: null }, resend, true).enabled, 1);
  // Edited threshold: a fresh rule.
  assert.deepEqual(mergeRule(fired, { ...resend, value: 1.6 }, true), { enabled: 1, armed: 1, last_fired: null });
  assert.deepEqual(mergeRule(undefined, resend, true), { enabled: 1, armed: 1, last_fired: null });
  // Switching off always wins.
  assert.equal(mergeRule({ ...fired, enabled: 1, last_fired: null }, { ...resend, enabled: 0 }, true).enabled, 0);
});

test("UPSERT_RULE (the SQL the PUT runs) agrees with mergeRule on every case", async () => {
  const db = makeD1();
  const olds = [undefined];
  for (const enabled of [0, 1]) for (const armed of [0, 1]) for (const last_fired of [null, 1000]) {
    olds.push({ kind: "above", value: 1.5, window: 0, enabled, armed, last_fired });
  }
  const news = [];
  for (const enabled of [0, 1]) for (const seen_fired of [0, 900, 1000, 1100]) for (const value of [1.5, 1.6]) {
    news.push({ kind: "above", value, window: 0, enabled, seen_fired });
  }
  news.push({ kind: "move", value: 1.5, window: 3600, enabled: 1, seen_fired: 0 });
  let n = 0;
  for (const old of olds) for (const incoming of news) for (const oneshot of [false, true]) for (const repeating of [null, 0, 1]) {
    const r = { ...incoming, repeating };
    const token = String(n++);
    if (old) {
      db.raw.prepare("INSERT INTO rules (token, id, kind, value, window, enabled, armed, last_fired) VALUES (?, 'x', ?, ?, ?, ?, ?, ?)")
        .run(token, old.kind, old.value, old.window, old.enabled, old.armed, old.last_fired);
    }
    await db.prepare(UPSERT_RULE).bind(token, "x", r.kind, r.value, r.window, r.enabled, oneshot ? 1 : 0, r.seen_fired, r.repeating).run();
    const got = db.one("SELECT enabled, armed, last_fired FROM rules WHERE token = ?", token);
    assert.deepEqual(got, mergeRule(old, r, oneshot), JSON.stringify({ old, r, oneshot }));
  }
  assert.equal(n, (olds.length) * news.length * 2 * 3);
});

test("sanitizeRule", () => {
  assert.deepEqual(sanitizeRule({ id: "a-1", kind: "above", value: 0.9 }), { id: "a-1", kind: "above", value: 0.9, window: 0, enabled: 1, seen_fired: 0, repeating: null });
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: 1, repeat: true }).repeating, 1);
  assert.equal(sanitizeRule({ id: "a", kind: "move", value: 5, window: 300, repeat: false }).repeating, 0);
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: 1, repeat: "true" }), null);
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: 1, seen_fired: 1700000000 }).seen_fired, 1700000000);
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: 1, seen_fired: "x" }).seen_fired, 0);
  assert.equal(sanitizeRule({ id: "a", kind: "move", value: 5, window: 7200 }), null);
  assert.equal(sanitizeRule({ id: "a", kind: "move", value: 2, window: 300 }).window, 300);
  assert.equal(sanitizeRule({ id: "a", kind: "move", value: 0.1, window: 3600 }), null);
  assert.equal(sanitizeRule({ id: "a b", kind: "above", value: 1 }), null);
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: -1 }), null);
  assert.equal(sanitizeRule({ id: "a", kind: "nope", value: 1 }), null);
  assert.equal(sanitizeRule({ id: "a", kind: "below", value: 1, enabled: false }).enabled, 0);
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: 0.87654 }).value, 0.88);   // 2 decimals max
  assert.equal(sanitizeRule({ id: "a", kind: "move", value: 12.345, window: 3600 }).value, 12.35);
  assert.equal(sanitizeRule({ id: "a", kind: "above", value: 0.004 }), null);           // rounds to $0.00
  assert.deepEqual(sanitizeRule({ id: "a", kind: "reach", value: 0.604, window: 3600 }), { id: "a", kind: "reach", value: 0.6, window: 0, enabled: 1, seen_fired: 0, repeating: null });
  assert.equal(sanitizeRule({ id: "a", kind: "reach", value: 0 }), null);
});

test("price: median of sources, lone outlier rejected", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2]), 1.5);
  const q = { coinex: { last: 0.7999, open24: 0.618 }, bigone: { last: 0.8209, open24: 0.6195 }, whattomine: { last: 0.789 } };
  assert.deepEqual(combine(q, 0.8), { usd: 0.7999, open24: (0.618 + 0.6195) / 2, n: 3, src: "median" });
  assert.equal(combine({ coinex: { last: 0.11 }, bigone: null, whattomine: null }, 0.8), null);
  assert.equal(combine({ coinex: { last: 0.82 }, bigone: null, whattomine: null }, 0.8).usd, 0.82);
  assert.equal(combine({ coinex: null, bigone: null, whattomine: null }, 0.8), null);
  assert.equal(pctChange(1.1, 1).toFixed(6), "10.000000");
});

test("price: a fresh SafeTrade quote wins, unless it is far off the median", () => {
  const q = { coinex: { last: 0.8631, open24: 0.67 }, bigone: { last: 0.8702 }, whattomine: { last: 0.86 } };
  assert.deepEqual(combine(q, 0.86, { last: 0.85, open24: 0.67 }), { usd: 0.85, open24: 0.67, n: 4, src: "safetrade" });
  assert.equal(combine(q, 0.86, { last: 0.85 }).open24, 0.67);                  // no ST open → median open
  assert.equal(combine(q, 0.86, { last: 0.5 }).src, "median");                  // -42%: broken print
  assert.equal(combine(q, 0.86, null).src, "median");
  const none = { coinex: null, bigone: null, whattomine: null };
  assert.equal(combine(none, 0.86, { last: 0.85 }).usd, 0.85);                  // alone, near prev
  assert.equal(combine(none, 0.86, { last: 0.2 }), null);                       // alone, huge jump
  assert.equal(combine(none, null, { last: 0.85 }).src, "safetrade");
});

test("price: SafeTrade ticker body validation", () => {
  const now = 1789736328;
  const body = { at: String(now), ticker: { last: "0.86", open: "0.67", high: "1" } };
  assert.deepEqual(parseSafeTrade(body, now + 20), { last: 0.86, open24: 0.67, at: now });
  assert.equal(parseSafeTrade(body, now + 400), null);                          // stale
  assert.equal(parseSafeTrade({ at: String(now), ticker: { last: "0" } }, now), null);
  assert.equal(parseSafeTrade({ at: String(now) }, now), null);
  assert.equal(parseSafeTrade("<!DOCTYPE html>", now), null);
  assert.equal(parseSafeTrade(null, now), null);
});

test("copy: USD formatting and localized payloads", () => {
  assert.equal(fmtUSD(0.9), "$0.90");
  assert.equal(fmtUSD(0.8783), "$0.88");
  assert.equal(fmtUSD(0.875), "$0.88");
  assert.equal(fmtUSD(1.5), "$1.50");
  assert.equal(fmtUSD(123.456), "$123.46");
  let p = payloadFor("zh-Hans", { id: "x", kind: "above", value: 0.9 }, 0.9123);
  assert.deepEqual(p.aps.alert, { title: "PRL 涨破 $0.90", body: "现价 $0.91，已高于你设置的 $0.90。" });
  p = payloadFor("en", { id: "x", kind: "move", value: 10, window: 86400 }, 0.8, -12.345);
  assert.equal(p.aps.alert.title, "PRL down 12.3% in 24h");
  p = payloadFor("ru", { id: "x", kind: "move", value: 5, window: 3600 }, 0.8, 5.2);
  assert.equal(p.aps.alert.title, "PRL вырос на 5.2% за 1 ч");
  p = payloadFor("zh-Hans", { id: "x", kind: "move", value: 3, window: 300 }, 0.8, -3.5);
  assert.equal(p.aps.alert.title, "PRL 5 分钟下跌 3.5%");
  p = payloadFor("en", { id: "x", kind: "move", value: 3, window: 300 }, 0.8, 3.5);
  assert.equal(p.aps.alert.title, "PRL up 3.5% in 5 min");
  p = payloadFor("zh-Hans", { id: "x", kind: "reach", value: 0.6 }, 0.61, 1);
  assert.deepEqual(p.aps.alert, { title: "PRL 涨破 $0.60", body: "现价 $0.61，已高于你设置的 $0.60。" });
  assert.equal(p.alert.kind, "reach");
  p = payloadFor("zh-Hans", { id: "x", kind: "reach", value: 0.6 }, 0.59, -1);
  assert.deepEqual(p.aps.alert, { title: "PRL 跌破 $0.60", body: "现价 $0.59，已低于你设置的 $0.60。" });
  assert.equal(deferredPayloadFor("en", { rule_id: "r", kind: "reach", value: 0.6, change: -1 }, 0.58, "03:12").aps.alert.title, "PRL below $0.60");
  assert.equal(deferredPayloadFor("en", { rule_id: "r", kind: "reach", value: 0.6, change: 1 }, 0.62, "03:12").aps.alert.title, "PRL above $0.60");
  assert.equal(payloadFor("xx", null, 0.8).aps.alert.title, "Price alerts are on");
  assert.equal(payloadFor("zh-Hant", null, 0.8).alert.test, true);
});

test("copy: every language the app ships has every price notification", () => {
  // The app reports its .lproj code; one without copy here is notified in English.
  const rule = (kind, extra) => ({ id: "x", kind, value: 0.9, ...extra });
  const all = (lang) => [
    payloadFor(lang, null, 0.8),
    payloadFor(lang, rule("above"), 0.91),
    payloadFor(lang, rule("below"), 0.89),
    payloadFor(lang, rule("reach"), 0.91, 1),
    payloadFor(lang, rule("reach"), 0.89, -1),
    ...[300, 3600, 86400].flatMap((window) => [5.2, -12.345].map((ch) => payloadFor(lang, rule("move", { window }), 0.8, ch))),
    deferredPayloadFor(lang, { rule_id: "r", kind: "below", value: 0.9 }, 0.89, "03:12"),
  ].map((p) => p.aps.alert);
  const english = all("en");
  for (const lang of LANGS) {
    const alerts = all(lang);
    for (const [i, a] of alerts.entries()) {
      assert.ok(a.title && a.body, lang);
      assert.doesNotMatch(a.title + a.body, /undefined|NaN|\[object|\$\{/, lang);
      assert.match(a.body, /\$0\.\d\d/, `${lang}: the body gives the price`);
      // A lock screen cuts a title off a little past this.
      assert.ok([...a.title].length <= 34, `${lang}: ${a.title}`);
      if (lang !== "en") assert.notEqual(a.title, english[i].title, lang);
    }
    assert.match(alerts.at(-1).body, /03:12/, `${lang}: a held-back alert says when it fired`);
    // Each window is named, so three moves read as three different notifications.
    assert.equal(new Set(alerts.slice(3, 9).map((a) => a.title)).size, 6, lang);
  }
});

test("APNs JWT: ES256, verifies against the key's public half", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const jwt = await signJWT({ keyPem: pem, keyId: "ABC123DEFG", teamId: "TEAM000000", iat: 1700000000 });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "ABC123DEFG" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url")), { iss: "TEAM000000", iat: 1700000000 });
  const sig = Buffer.from(s, "base64url");
  assert.equal(sig.length, 64); // raw r||s, not DER
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, sig, new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
});

// 2026-09-23 00:00:00 UTC
const MIDNIGHT_UTC = Date.UTC(2026, 8, 23) / 1000;
const at = (h, m = 0) => MIDNIGHT_UTC + h * 3600 + m * 60;

test("push window: validation", () => {
  assert.equal(sanitizeWindow(null), null);
  assert.equal(sanitizeWindow({ start: 480, end: 480, tz: "UTC" }), null);      // empty window = all day
  assert.equal(sanitizeWindow({ start: -1, end: 60, tz: "UTC" }), null);
  assert.equal(sanitizeWindow({ start: 480, end: 1440, tz: "UTC" }), null);
  assert.deepEqual(sanitizeWindow({ start: 480, end: 1380, tz: "Asia/Shanghai" }), { start: 480, end: 1380, tz: "Asia/Shanghai" });
  assert.equal(sanitizeWindow({ start: 480, end: 1380, tz: "Mars/Olympus" }).tz, "UTC");
});

test("push window: open / closed in the device's time zone", () => {
  const w = { start: 8 * 60, end: 23 * 60, tz: "Asia/Shanghai" };            // 08:00–23:00 Beijing
  assert.equal(windowOpen(null, at(3)), true);                                 // all day
  assert.equal(windowOpen({ start: null, end: null }, at(3)), true);
  assert.equal(windowOpen(w, at(19)), false);    // 03:00 Beijing
  assert.equal(windowOpen(w, at(23, 59)), false); // 07:59
  assert.equal(windowOpen(w, at(0)), true);      // 08:00 — first minute of the window
  assert.equal(windowOpen(w, at(14, 59)), true); // 22:59
  assert.equal(windowOpen(w, at(15)), false);    // 23:00 — end is exclusive
  const wrap = { start: 22 * 60, end: 2 * 60, tz: "UTC" };                    // 22:00–02:00
  assert.equal(windowOpen(wrap, at(23)), true);
  assert.equal(windowOpen(wrap, at(1, 30)), true);
  assert.equal(windowOpen(wrap, at(12)), false);
  assert.equal(localHM(at(19, 12), "Asia/Shanghai"), "03:12");
});

test("deferred payload: title of the event, body with when it fired and the price now", () => {
  const q = { rule_id: "r1", kind: "above", value: 1.5, window: 0, change: null };
  const p = deferredPayloadFor("zh-Hans", q, 1.48, "03:12");
  assert.equal(p.aps.alert.title, "PRL 涨破 $1.50");
  assert.equal(p.aps.alert.body, "03:12 在免打扰时段内触发，现价 $1.48。");
  assert.equal(p.alert.id, "r1");
  const m = deferredPayloadFor("en", { rule_id: "r2", kind: "move", value: 5, window: 3600, change: -6.2 }, 1.1, "02:00");
  assert.equal(m.aps.alert.title, "PRL down 6.2% in 1h");
  assert.match(m.aps.alert.body, /^Triggered at 02:00/);
});

// A JWS shaped like Apple's (signature not checked by the worker).
const jws = (o) => ["eyJhbGciOiJFUzI1NiJ9", Buffer.from(JSON.stringify(o)).toString("base64url"), "sig"].join(".");
const asn = (type, tx, extra = {}) => ({
  signedPayload: jws({
    notificationType: type, notificationUUID: "u-" + type, version: "2.0",
    data: { bundleId: "com.prl.wizard", environment: "Production", ...(tx ? { signedTransactionInfo: jws(tx) } : {}) },
    ...extra,
  }),
});
const buy = { productId: "com.prl.wizard.pro", price: 2990, currency: "USD", storefront: "USA",
              transactionId: "2000001", inAppOwnershipType: "PURCHASED", environment: "Production" };

test("asn: JWS payload decoding (base64url, UTF-8, junk)", () => {
  assert.deepEqual(jwsPayload(jws({ a: "中文?>" })), { a: "中文?>" });
  assert.equal(jwsPayload("nope"), null);
  assert.equal(jwsPayload("a.!!!.c"), null);
  assert.equal(jwsPayload(undefined), null);
});

test("asn: purchase → fields", () => {
  const n = parseNotification(asn("ONE_TIME_CHARGE", buy));
  assert.deepEqual(n, { uuid: "u-ONE_TIME_CHARGE", type: "ONE_TIME_CHARGE", subtype: null, env: "Production",
    bundleId: "com.prl.wizard", product: "com.prl.wizard.pro", price: 2990, currency: "USD", storefront: "USA",
    familyShared: false, tx: "2000001", originalTx: null });
  assert.equal(parseNotification(asn("REFUND", { ...buy, originalTransactionId: "1000001" })).originalTx, "1000001");
});


test("asn: TEST / unknown types, bad bodies", () => {
  const t = parseNotification(asn("TEST", null));
  const odd = parseNotification(asn("SUBSCRIBED", null, { subtype: "INITIAL_BUY" }));
  assert.equal(parseNotification({}), null);
  assert.equal(parseNotification(null), null);
  assert.equal(parseNotification({ signedPayload: jws({ notificationType: "TEST" }) }), null); // no UUID
});
