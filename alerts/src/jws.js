// Apple-signed JWS verification (StoreKit 2 transactions, App Store Server
// Notifications V2) with WebCrypto only — no library in a Worker.
//
// Apple signs with ES256 and ships the chain in the header's x5c:
//   [0] leaf          "Prod ECC Mac App Store and iTunes Store Receipt Signing"
//                     (P-256, marker extension 1.2.840.113635.100.6.11.1)
//   [1] intermediate  "Apple Worldwide Developer Relations CA - G6"
//                     (P-384, marker extension 1.2.840.113635.100.6.2.1)
//   [2] root          "Apple Root CA - G3", pinned by its SHA-256 below
// Each link's signature, validity (at the payload's signedDate) and marker
// extension are checked, then the JWS signature against the leaf key — the
// same checks as Apple's app-store-server-library, minus the online OCSP call.

/// SHA-256 of Apple Root CA - G3 (apple.com/certificateauthority/AppleRootCA-G3.cer).
export const APPLE_ROOT_G3_SHA256 = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";
const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

const HASH = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384" };
const CURVE = { "1.2.840.10045.3.1.7": ["P-256", 32], "1.3.132.0.34": ["P-384", 48] };

// ── DER ──────────────────────────────────────────────────────────────────────

function tlv(buf, pos, end = buf.length) {
  if (pos + 2 > end) throw new Error("der: truncated");
  const tag = buf[pos];
  let len = buf[pos + 1];
  let head = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || head + n > end) throw new Error("der: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[head + i];
    head += n;
  }
  if (head + len > end) throw new Error("der: truncated");
  return { tag, start: pos, head, end: head + len };
}

function kids(buf, node) {
  const out = [];
  for (let p = node.head; p < node.end; ) {
    const c = tlv(buf, p, node.end);
    out.push(c);
    p = c.end;
  }
  return out;
}

function oidOf(buf, node) {
  if (node.tag !== 0x06) throw new Error("der: not an OID");
  const b = buf.subarray(node.head, node.end);
  const arcs = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { arcs.push(v); v = 0; }
  }
  return arcs.join(".");
}

function timeOf(buf, node) {
  const s = new TextDecoder().decode(buf.subarray(node.head, node.end));
  const m = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
          : node.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : null;
  if (!m) throw new Error("der: bad time");
  let y = Number(m[1]);
  if (node.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/// DER ECDSA-Sig-Value (SEQUENCE { r, s }) → the raw r||s WebCrypto verifies.
export function derToRawSig(der, size) {
  const [r, s] = kids(der, tlv(der, 0));
  const out = new Uint8Array(size * 2);
  for (const [i, n] of [[0, r], [1, s]]) {
    let v = der.subarray(n.head, n.end);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("der: bad signature");
    out.set(v, (i + 1) * size - v.length);
  }
  return out;
}

// ── X.509 ────────────────────────────────────────────────────────────────────

/// The parts of a DER certificate this module needs.
export function parseCert(der) {
  const [tbs, alg, sig] = kids(der, tlv(der, 0));
  const f = kids(der, tbs);
  let i = f[0].tag === 0xa0 ? 1 : 0;              // [0] version
  i++;                                            // serialNumber
  i++;                                            // signature AlgorithmIdentifier
  const issuer = f[i++];
  const [notBefore, notAfter] = kids(der, f[i++]);
  const subject = f[i++];
  const spki = f[i++];
  const exts = [];
  for (; i < f.length; i++) {
    if (f[i].tag !== 0xa3) continue;              // [3] extensions
    for (const e of kids(der, kids(der, f[i])[0])) exts.push(oidOf(der, kids(der, e)[0]));
  }
  const bits = der.subarray(sig.head, sig.end);   // BIT STRING: unused-bits byte, then the DER signature
  const [, curveOID] = kids(der, kids(der, spki)[0]);
  return {
    der,
    tbs: der.subarray(tbs.start, tbs.end),
    sigAlg: oidOf(der, kids(der, alg)[0]),
    sig: bits.subarray(1),
    issuer: der.subarray(issuer.start, issuer.end),
    subject: der.subarray(subject.start, subject.end),
    notBefore: timeOf(der, notBefore),
    notAfter: timeOf(der, notAfter),
    spki: der.subarray(spki.start, spki.end),
    curve: oidOf(der, curveOID),
    exts,
  };
}

async function publicKey(cert) {
  const c = CURVE[cert.curve];
  if (!c) throw new Error("x509: unsupported curve");
  return crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: c[0] }, false, ["verify"]);
}

/// Is `child` signed by `parent`'s key?
export async function signedBy(child, parent) {
  const hash = HASH[child.sigAlg];
  const size = (CURVE[parent.curve] || [])[1];
  if (!hash || !size) return false;
  const raw = derToRawSig(child.sig, size);
  return crypto.subtle.verify({ name: "ECDSA", hash }, await publicKey(parent), raw, child.tbs);
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => b64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

// ── JWS ──────────────────────────────────────────────────────────────────────

/// Verify an Apple-signed compact JWS; → its decoded payload, or null for
/// anything that is not provably Apple's. `rootSHA256` (hex) replaces the pinned
/// root — for tests, which sign with a throwaway chain.
export async function verifyAppleJWS(jws, { rootSHA256 = APPLE_ROOT_G3_SHA256, now = Date.now() } = {}) {
  try {
    const parts = typeof jws === "string" ? jws.split(".") : [];
    if (parts.length !== 3) return null;
    const head = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
    if (head.alg !== "ES256" || !Array.isArray(head.x5c) || head.x5c.length < 3) return null;

    const [leaf, mid, root] = head.x5c.slice(0, 3).map((c) => parseCert(b64(c)));
    if (hex(await crypto.subtle.digest("SHA-256", root.der)) !== rootSHA256.toLowerCase()) return null;
    if (!same(leaf.issuer, mid.subject) || !same(mid.issuer, root.subject)) return null;
    if (!mid.exts.includes(INTERMEDIATE_OID) || !leaf.exts.includes(LEAF_OID)) return null;
    // Validity at signing time (Apple's own rule): a transaction signed while the
    // chain was valid stays verifiable after the leaf rotates out.
    const at = Number.isFinite(payload.signedDate) ? payload.signedDate : now;
    if ([leaf, mid].some((c) => at < c.notBefore || at > c.notAfter)) return null;
    if (!(await signedBy(mid, root)) || !(await signedBy(leaf, mid))) return null;
    if (leaf.curve !== "1.2.840.10045.3.1.7") return null;   // ES256 = P-256

    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(leaf),
                                          b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? payload : null;
  } catch {
    return null;
  }
}
