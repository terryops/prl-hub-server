import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verificationEmail, EMAIL_LANGS } from "../src/account-email.js";
import { LANGS } from "../src/i18n.js";
import { setupAccount, challenge, request } from "./account-fixture.js";
import { restoreNow } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; restoreNow(); });

test("account email: leading zeros survive in subject, selectable HTML and plain text", () => {
  const mail = verificationEmail({ code: "006428", lang: "zh-Hans" });
  assert.ok(mail.subject.includes("006428"));
  assert.equal(mail.text.match(/\b\d{6}\b/)[0], "006428");
  assert.match(mail.html, /class="email-code"[^>]*>006428<\/p>/);
  assert.ok(!mail.html.includes("0 0 6 4 2 8"));
  assert.ok(mail.html.includes("5 分钟内有效"));
  assert.ok(!/<(?:script|img|iframe)\b|@import|url\(/i.test(mail.html));
});
test("account email: all sixteen languages and all sensitive purposes have distinct readable titles", () => {
  assert.deepEqual([...EMAIL_LANGS].sort(), [...LANGS].sort());
  const subjects = new Set();
  for (const lang of EMAIL_LANGS) {
    const titles = new Set();
    for (const purpose of ["login", "delete", "change_old", "change_new", "purchase"]) {
      const mail = verificationEmail({ code: "123456", lang, purpose });
      assert.ok(mail.text.length > 80); assert.match(mail.html, /role="presentation"/);
      assert.match(mail.html, new RegExp(`<html lang="${lang}">`));
      assert.ok(!mail.text.includes("change_old") && !mail.text.includes("change_new"));
      titles.add(mail.subject); subjects.add(mail.subject);
    }
    assert.equal(titles.size, 5, lang);
  }
  assert.equal(subjects.size, EMAIL_LANGS.length * 5);
});
test("account email: arbitrary locale never becomes HTML and malformed codes or purposes are refused", () => {
  const mail = verificationEmail({ code: "123456", lang: '\"><img src=x onerror=alert(1)>' });
  assert.ok(mail.text.includes("Your sign-in code"));
  assert.ok(!mail.html.includes("onerror"));
  assert.ok(verificationEmail({ code: "123456", lang: "zh-TW" }).text.includes("登入"));
  for (const code of ["12345", "1234567", "<12345", 123456]) assert.throws(() => verificationEmail({ code }));
  assert.throws(() => verificationEmail({ code: "123456", purpose: "<script>" }));
});
test("account email: the styled email contains the exact live challenge code and login still consumes it once", async () => {
  const f = setupAccount(), proof = await challenge(f);
  assert.equal(proof.response.status, 200);
  const mail = f.emails.at(-1);
  assert.equal(mail.to, "person@qq.com");
  assert.match(mail.html, new RegExp(`class="email-code"[^>]*>${proof.code}</p>`));
  assert.ok(mail.subject.includes(proof.code));
  assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", proof)).status, 200);
  assert.equal((await request(f.env, "POST", "/v1/auth/email/verify", proof)).status, 401);
});
