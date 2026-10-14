// Error text is useful operational evidence, but request URLs and credentials
// can be embedded in upstream errors and must not enter observability logs.
export function logError(label, error, env = {}, req) {
  let detail = error?.stack || `${error?.name || "Error"}: ${error?.message || String(error)}`;
  const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PRIVATE|PEPPER|CONFIG_KEY|PAY_ADDRESS|VAPID_PUBLIC|BLOCKBOOK_BASE/.test(key) && typeof value === "string").map(([, value]) => value);
  const authorization = req?.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (authorization) secrets.push(authorization);
  const purchase = req?.headers.get("x-purchase-key");
  if (purchase) secrets.push(purchase);
  const cookie = req?.headers.get("cookie");
  if (cookie) for (const pair of cookie.split(";")) { const value = pair.slice(pair.indexOf("=") + 1).trim(); if (value) secrets.push(value); }
  for (const secret of secrets.flatMap((s) => s.split(",")).filter(Boolean)) detail = detail.split(secret).join("[redacted]");
  detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:ph1_[A-Za-z0-9_-]+|[a-f0-9]{64,200}|(?:t?prl1)[a-z0-9]{20,100})\b/gi, "[redacted]")
    .replace(/https?:\/\/[^\s)]+/g, (url) => /:\d+:\d+$/.test(url) ? url : "[upstream URL]");
  console.error(label, detail);
}
