const SECRET_NAMES = /TOKEN|SECRET|PRIVATE|PEPPER|CONFIG_KEY|PAY_ADDRESS|VAPID_PUBLIC|BLOCKBOOK_BASE|BLOCKBOOK_KEY|SERVICE_ACCOUNT/;
/// Settings that only share a secret's prefix (ACCOUNT_CONFIG_KEY_VERSION = "1", PAY_ADDRESS_SINCE).
const NOT_SECRET = /_(?:VERSION|SINCE|ENABLED)$/;
/// No credential is this short, and replacing a short value ("1") rewrites every digit of the log.
const MIN_SECRET = 8;
/// The pieces of one secret that may turn up in error text: a comma-separated list item by item; a
/// service-account JSON its key id, account and private key, the key also a line at a time.
function secretParts(key, value) {
  if (!/SERVICE_ACCOUNT/.test(key)) return value.split(",");
  let o;
  try { o = JSON.parse(value); } catch { return [value]; }
  const lines = String(o?.private_key ?? "").split(/\\n|\n/).filter((l) => l.length >= 16 && !l.startsWith("-----"));
  return [value, o?.private_key, o?.private_key_id, o?.client_email, ...lines].filter((s) => typeof s === "string");
}

// Error text is useful operational evidence, but request URLs and credentials
// can be embedded in upstream errors and must not enter observability logs.
export function logError(label, error, env = {}, req) {
  let detail = error?.stack || `${error?.name || "Error"}: ${error?.message || String(error)}`;
  const secrets = Object.entries(env).filter(([key, value]) => SECRET_NAMES.test(key) && !NOT_SECRET.test(key) && typeof value === "string").flatMap(([key, value]) => secretParts(key, value));
  const authorization = req?.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (authorization) secrets.push(...authorization.split(","));
  const purchase = req?.headers.get("x-purchase-key");
  if (purchase) secrets.push(...purchase.split(","));
  const cookie = req?.headers.get("cookie");
  if (cookie) for (const pair of cookie.split(";")) { const value = pair.slice(pair.indexOf("=") + 1).trim(); if (value) secrets.push(...value.split(",")); }
  for (const secret of secrets.filter((s) => s && s.trim().length >= MIN_SECRET)) detail = detail.split(secret).join("[redacted]");
  detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:ph1_[A-Za-z0-9_-]+|[a-f0-9]{64,200}|(?:t?prl1)[a-z0-9]{20,100})\b/gi, "[redacted]")
    .replace(/https?:\/\/[^\s)]+/g, (url) => /:\d+:\d+$/.test(url) ? url : "[upstream URL]");
  console.error(label, detail);
}
