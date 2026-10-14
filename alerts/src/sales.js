// App Store Server Notifications (V2): Apple POSTs { signedPayload } to
// /v1/asn/<ASN_SECRET>, a JWS whose payload carries the notification type and, nested,
// the signed transaction. verifyAppleJWS (jws.js) is what proves Apple signed it.

export const PRO = "com.prl.wizard.pro";

/// The decoded payload of a compact JWS (header.payload.signature), or null.
/// Decoding only — verifyAppleJWS (jws.js) is what proves Apple signed it.
export function jwsPayload(jws) {
  const part = typeof jws === "string" ? jws.split(".")[1] : null;
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/// The request body Apple sends → the fields worth a notification, or null.
export function parseNotification(body) {
  return notificationFields(jwsPayload(body && body.signedPayload));
}

/// A decoded (verified) signedPayload → the fields worth a notification, or null.
export function notificationFields(n) {
  if (!n || typeof n.notificationType !== "string" || typeof n.notificationUUID !== "string") return null;
  const data = n.data || {};
  const tx = jwsPayload(data.signedTransactionInfo) || {};
  return {
    uuid: n.notificationUUID,
    type: n.notificationType,
    subtype: n.subtype || null,
    env: data.environment || tx.environment || "Production",
    bundleId: data.bundleId || tx.bundleId || null,
    product: tx.productId || null,
    price: Number.isFinite(tx.price) ? tx.price : null, // milliunits of `currency`
    currency: tx.currency || null,
    storefront: tx.storefront || null,                   // ISO 3166-1 alpha-3
    familyShared: tx.inAppOwnershipType === "FAMILY_SHARED",
    tx: tx.transactionId || null,
    originalTx: tx.originalTransactionId || null,
  };
}

