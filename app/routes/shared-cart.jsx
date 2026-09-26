// App Proxy endpoint, storefront path /apps/dr-account/shared-cart.
//
// Named shared-cart (not apps.dr-account.shared-cart) because Shopify forwards
// /apps/dr-account/<path> to the proxy URL as just /<path>. The older
// apps.dr-account.pre-select route never matches for that reason (it belongs
// to the unused OIDC login, so nothing depends on it).
//
// GET  ?known=<v> returns the store's shared cart { enabled, v, lines, at },
//      or { enabled, v, unchanged: true } when the device already has v
//      (devices poll every few seconds while the page is open)
// POST body { baseVersion, lines }
//      -> 200 { ok, v, lines, at } when the store was still on baseVersion
//      -> 409 { conflict, v, lines, at } when another device saved first;
//         the theme merges and posts again
//
// Answers { enabled: false } for anyone not logged in, not buying for a store,
// whose store is not switched on, or on any error, so the browser cart simply
// carries on as normal. See app/lib/shared-cart.server.js.

import { verifyProxySignature, json } from "../lib/app-proxy.server.js";
import { resolveLocation, readState, writeState, sanitizeLines } from "../lib/shared-cart.server.js";

async function context(request) {
  const url = new URL(request.url);
  if (!verifyProxySignature(url, process.env.SHOPIFY_API_SECRET)) return { error: json({ error: "invalid_signature" }, 401) };
  const customerId = url.searchParams.get("logged_in_customer_id");
  const shop = url.searchParams.get("shop");
  if (!customerId || !shop) return { error: json({ enabled: false }) };
  const requestedLocationId = url.searchParams.get("location_id") || null;
  const { location, enabled } = await resolveLocation({ shop, customerId, requestedLocationId });
  if (!location || !enabled) return { error: json({ enabled: false }) };
  return { shop, location, customerId, url };
}

export const loader = async ({ request }) => {
  try {
    const ctx = await context(request);
    if (ctx.error) return ctx.error;
    const state = await readState(ctx.shop, ctx.location.id);
    const known = ctx.url.searchParams.get("known");
    if (known !== null && Number(known) === state.v) return json({ enabled: true, v: state.v, unchanged: true });
    // ?stream=1: also hand out a signed token for the live stream. Only here,
    // where Shopify has proved who the customer is and which store it is.
    if (ctx.url.searchParams.get("stream") === "1") {
      const { makeStreamToken } = await import("../lib/shared-cart-events.server.js");
      const streamUrl = `${process.env.SHOPIFY_APP_URL}/shared-cart-stream?t=${encodeURIComponent(makeStreamToken(ctx.shop, ctx.location.id))}`;
      return json({ enabled: true, ...state, streamUrl });
    }
    return json({ enabled: true, ...state });
  } catch (err) {
    console.error("[shared-cart] GET failed:", err?.message ?? err);
    return json({ enabled: false, error: "unavailable" });
  }
};

export const action = async ({ request }) => {
  try {
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const ctx = await context(request);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => null);
    if (!body || !Number.isInteger(body.baseVersion) || body.baseVersion < 0) return json({ error: "bad_request" }, 400);
    const lines = sanitizeLines(body.lines);
    const res = await writeState(ctx.shop, ctx.location.id, { lines, by: `customer ${ctx.customerId}` }, body.baseVersion);
    if (!res.ok) return json({ conflict: true, ...res.state }, 409);
    return json({ ok: true, ...res.state });
  } catch (err) {
    console.error("[shared-cart] POST failed:", err?.message ?? err);
    return json({ enabled: false, error: "unavailable" });
  }
};
