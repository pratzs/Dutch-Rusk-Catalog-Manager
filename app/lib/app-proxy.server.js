import crypto from "node:crypto";

/**
 * Verify a Shopify App Proxy request. Shopify signs the query string (sorted,
 * joined as key=value with no separator) with the app secret; only a request
 * that came through the storefront proxy carries a valid signature, and only
 * then can `logged_in_customer_id` be trusted.
 */
export function verifyProxySignature(url, secret) {
  const params = new URLSearchParams(url.search);
  const signature = params.get("signature");
  if (!signature || !secret) return false;
  params.delete("signature");
  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export const PROXY_JSON = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: PROXY_JSON });
}
