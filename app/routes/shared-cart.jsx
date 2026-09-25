// App Proxy endpoint, storefront path /apps/dr-account/shared-cart.
//
// Named shared-cart (not apps.dr-account.shared-cart) because Shopify forwards
// /apps/dr-account/<path> to the proxy URL as just /<path>. The older
// apps.dr-account.pre-select route never matches for that reason (it belongs
// to the unused OIDC login, so nothing depends on it).
//
// GET  returns the store's shared cart: { enabled, v, lines, at }
// POST saves this browser's cart:       body { baseVersion, lines }
//      -> 200 { ok, v, lines, at } when baseVersion matched
//      -> 409 { conflict, v, lines, at } when another device saved first;
//         the theme merges and posts again
//
// Refuses (enabled: false) for anyone not logged in, not buying for a store,
// or whose store is not switched on. See app/lib/shared-cart.server.js.

import { verifyProxySignature, json } from "../lib/app-proxy.server.js";
import { resolveLocation, readState, writeState, sanitizeLines } from "../lib/shared-cart.server.js";

async function context(request) {
  const url = new URL(request.url);
  if (!verifyProxySignature(url, process.env.SHOPIFY_API_SECRET)) return { error: json({ error: "invalid_signature" }, 401) };
  const customerId = url.searchParams.get("logged_in_customer_id");
  const shop = url.searchParams.get("shop");
  if (!customerId || !shop) return { error: json({ enabled: false }) };
  const requestedLocationId = url.searchParams.get("location_id") || null;
  const { admin, location, enabled } = await resolveLocation({ shop, customerId, requestedLocationId });
  if (!location || !enabled) return { error: json({ enabled: false }) };
  return { admin, location, customerId };
}

export const loader = async ({ request }) => {
  try {
    const ctx = await context(request);
    if (ctx.error) return ctx.error;
    const { state } = await readState(ctx.admin, ctx.location.id);
    return json({ enabled: true, ...state });
  } catch (err) {
    console.error("[shared-cart] GET failed:", err?.message ?? err);
    // Fail closed for the feature, open for the customer: the theme treats
    // this as "not enabled" and the browser cart carries on as normal.
    return json({ enabled: false, error: "unavailable" });
  }
};

export const action = async ({ request }) => {
  try {
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const ctx = await context(request);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => null);
    if (!body || !Number.isInteger(body.baseVersion)) return json({ error: "bad_request" }, 400);
    const lines = sanitizeLines(body.lines);

    // Shopify can take a second or two to return a value that was just
    // written. A browser quoting a version NEWER than what we read means our
    // read is stale, not that the browser is wrong, so read again first.
    let { state, digest } = await readState(ctx.admin, ctx.location.id);
    for (let i = 0; i < 4 && body.baseVersion > state.v; i++) {
      await new Promise((r) => setTimeout(r, 700));
      ({ state, digest } = await readState(ctx.admin, ctx.location.id));
    }
    if (body.baseVersion !== state.v) return json({ conflict: true, ...state }, 409);

    const res = await writeState(ctx.admin, ctx.location.id, { lines, by: `customer ${ctx.customerId}` }, digest, state.v);
    if (!res.ok) {
      const fresh = await readState(ctx.admin, ctx.location.id);
      return json({ conflict: true, ...fresh.state }, 409);
    }
    return json({ ok: true, ...res.state });
  } catch (err) {
    console.error("[shared-cart] POST failed:", err?.message ?? err);
    return json({ enabled: false, error: "unavailable" });
  }
};
