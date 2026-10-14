import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyAppleJWS, parseCert, signedBy, derToRawSig, APPLE_ROOT_G3_SHA256 } from "../src/jws.js";
import { makeChain, signJWS, proTx, INTERMEDIATE_OID } from "./helpers.js";

const fixture = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

test("x509: Apple's real WWDR G6 is signed by the pinned Apple Root CA - G3", async () => {
  const root = parseCert(fixture("AppleRootCA-G3.cer"));
  const g6 = parseCert(fixture("AppleWWDRCAG6.cer"));
  const sha = Buffer.from(await crypto.subtle.digest("SHA-256", root.der)).toString("hex");
  assert.equal(sha, APPLE_ROOT_G3_SHA256);
  assert.equal(g6.curve, "1.3.132.0.34");                     // P-384
  assert.equal(g6.sigAlg, "1.2.840.10045.4.3.3");             // ecdsa-with-SHA384
  assert.ok(g6.exts.includes(INTERMEDIATE_OID));
  assert.deepEqual(Buffer.from(g6.issuer), Buffer.from(root.subject));
  assert.equal(await signedBy(g6, root), true);
  assert.equal(await signedBy(root, g6), false);
  assert.equal(new Date(g6.notAfter).toISOString(), "2036-03-19T00:00:00.000Z");
});

test("jws: a chain shaped like Apple's verifies and yields the payload", async () => {
  const chain = await makeChain();
  const jws = await signJWS(chain, proTx());
  assert.deepEqual(await verifyAppleJWS(jws, { rootSHA256: chain.rootSHA256 }), proTx());
  // …but not against Apple's real root.
  assert.equal(await verifyAppleJWS(jws), null);
});

test("jws: tampering, wrong chains and junk are rejected", async () => {
  const chain = await makeChain();
  const pin = { rootSHA256: chain.rootSHA256 };
  const jws = await signJWS(chain, proTx());
  const [h, p, s] = jws.split(".");
  const forged = Buffer.from(JSON.stringify(proTx({ productId: "com.prl.wizard.pro", originalTransactionId: "9" }))).toString("base64url");
  assert.equal(await verifyAppleJWS(`${h}.${forged}.${s}`, pin), null);            // payload swapped
  assert.equal(await verifyAppleJWS(`${h}.${p}.${s.slice(0, -4)}AAAA`, pin), null); // signature bent
  assert.equal(await verifyAppleJWS(await signJWS(chain, proTx(), { alg: "none" }), pin), null);
  assert.equal(await verifyAppleJWS(await signJWS(chain, proTx(), { x5c: chain.x5c.slice(0, 2) }), pin), null);

  // A leaf from another chain, re-parented onto this root.
  const other = await makeChain();
  const spliced = await signJWS(other, proTx(), { x5c: [other.x5c[0], chain.x5c[1], chain.x5c[2]] });
  assert.equal(await verifyAppleJWS(spliced, pin), null);

  // Missing Apple marker extensions.
  const noMid = await makeChain({ midExts: [] });
  assert.equal(await verifyAppleJWS(await signJWS(noMid, proTx()), { rootSHA256: noMid.rootSHA256 }), null);
  const noLeaf = await makeChain({ leafExts: [] });
  assert.equal(await verifyAppleJWS(await signJWS(noLeaf, proTx()), { rootSHA256: noLeaf.rootSHA256 }), null);

  // Leaf expired before the transaction was signed.
  const old = await makeChain({ leafNotAfter: Date.UTC(2025, 0, 1) });
  assert.equal(await verifyAppleJWS(await signJWS(old, proTx()), { rootSHA256: old.rootSHA256 }), null);
  // …yet a transaction signed while it was valid still verifies (Apple's rule).
  const early = proTx({ signedDate: Date.UTC(2024, 5, 1) });
  assert.deepEqual(await verifyAppleJWS(await signJWS(old, early), { rootSHA256: old.rootSHA256 }), early);

  for (const junk of [undefined, null, 42, "", "a.b", "a.b.c", "!!.!!.!!"]) {
    assert.equal(await verifyAppleJWS(junk, pin), null);
  }
});

test("der: ECDSA signature → raw r||s, sign byte stripped and left-padded", () => {
  // SEQUENCE { INTEGER 00 80 01, INTEGER 05 }
  const der = Uint8Array.of(0x30, 0x08, 0x02, 0x03, 0x00, 0x80, 0x01, 0x02, 0x01, 0x05);
  assert.deepEqual([...derToRawSig(der, 2)], [0x80, 0x01, 0x00, 0x05]);
  assert.deepEqual([...derToRawSig(der, 3)], [0x00, 0x80, 0x01, 0x00, 0x00, 0x05]);
  assert.throws(() => derToRawSig(der, 1));
});
