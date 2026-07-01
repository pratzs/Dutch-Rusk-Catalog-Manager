// App Proxy endpoint (mounted at /apps/dr-account/pre-select on the storefront).
// Called by the theme block right after login. Returns the target
// companyLocationGid our OIDC IdP stashed as a customer metafield, then clears
// the metafield so subsequent page loads don't keep redirecting.
//
// This endpoint MUST be behind Shopify's App Proxy so that it sees the signed
// `logged_in_customer_id` query param (Shopify writes this when it forwards
// storefront requests through the proxy).

import crypto from "node:crypto";
import { readTargetLocationMetafield, clearTargetLocationMetafield } from "../lib/storefront-preselect.server";

const CORS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

function verifyProxySignature(url, secret) {
  const params = new URLSearchParams(url.search);
  const signature = params.get("signature");
  if (!signature) return false;
  params.delete("signature");
  // Shopify sorts the params alphabetically and joins as "key=value" WITHOUT separators.
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const message = sorted.map(([k, v]) => `${k}=${v}`).join("");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: "misconfigured" }), { status: 500, headers: CORS });
  }
  if (!verifyProxySignature(url, secret)) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401, headers: CORS });
  }

  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");
  const shop = url.searchParams.get("shop");
  if (!loggedInCustomerId || !shop) {
    return new Response(JSON.stringify({ preselect: null }), { headers: CORS });
  }

  const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;
  try {
    const meta = await readTargetLocationMetafield({ shop, customerGid });
    if (meta.companyLocationGid) {
      // Fire-and-forget clear so repeat page loads don't keep redirecting.
      clearTargetLocationMetafield({ shop, customerGid }).catch((err) =>
        console.error("[pre-select] clear failed:", err.message)
      );
    }
    return new Response(JSON.stringify({ preselect: meta.companyLocationGid || null, username: meta.username || null }), { headers: CORS });
  } catch (err) {
    console.error("[pre-select] lookup failed:", err.message);
    return new Response(JSON.stringify({ preselect: null, error: "lookup_failed" }), { headers: CORS });
  }
};
