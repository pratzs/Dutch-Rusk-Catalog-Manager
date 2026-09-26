// Live push for the shared cart. When a store's cart is saved, every device
// open on that store is told straight away (Server-Sent Events), instead of
// waiting for its next poll.
//
// The stream is served straight from this app (not through Shopify's app
// proxy, which does not stream), so the device first gets a signed,
// short-lived token through the proxy, where Shopify has already proved who
// the customer is. The token names one shop and one shared cart (a cartKey:
// company location plus customer, see shared-cart.server.js), nothing else.
// "locationGid" below is that key. Messages carry that cart's new version
// and lines, exactly what the proxied GET would return to the same device.
//
// Connections are kept in memory. The app runs as a single instance on
// Render; if it is ever scaled out this needs a shared channel (Postgres
// LISTEN/NOTIFY would do), and until then devices still poll as a fallback.

import crypto from "node:crypto";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const channels = new Map(); // "shop|locationGid" -> Set<send(fn)>

function secret() {
  const s = process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET missing");
  return s;
}

export function channelKey(shop, locationGid) {
  return `${shop}|${locationGid}`;
}

/** Sign "which store's changes may this device listen to". */
export function makeStreamToken(shop, locationGid, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ s: shop, l: locationGid, e: now + TOKEN_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(`sc-stream.${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

/** Returns { shop, locationGid } for a valid, unexpired token, else null. */
export function readStreamToken(token, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(`sc-stream.${payload}`).digest("base64url");
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!p.s || !p.l || !(p.e > now)) return null;
    return { shop: p.s, locationGid: p.l };
  } catch {
    return null;
  }
}

export function subscribe(key, send) {
  if (!channels.has(key)) channels.set(key, new Set());
  channels.get(key).add(send);
  return () => {
    const set = channels.get(key);
    if (!set) return;
    set.delete(send);
    if (set.size === 0) channels.delete(key);
  };
}

/** Send every open device on this store its new cart ({ v, lines }). */
export function publish(shop, locationGid, msg) {
  const set = channels.get(channelKey(shop, locationGid));
  if (!set) return 0;
  for (const send of set) {
    try { send(msg); } catch { /* a dead connection is cleaned up on close */ }
  }
  return set.size;
}

export function connectionCount() {
  let n = 0;
  for (const set of channels.values()) n += set.size;
  return n;
}
