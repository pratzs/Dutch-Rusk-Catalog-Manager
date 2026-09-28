// Stores this device has already verified with our login (password or
// emailed code). Shopify's single sign-on asks us with prompt=none and a
// login_hint; if the hinted store is on this list we sign it in silently, so
// switching between an owner's stores needs no code and no password.
//
// Signed cookie on our own domain only. It never names a password, only
// B2BUser ids, and only ids this browser proved it could sign in as.

import { signCookiePayload, verifyCookiePayload } from "./crypto.server";
import { readCookieValue } from "./oidc-request.server";

export const DEVICE_COOKIE = "dr_idp_device";
const DEVICE_TTL_SEC = 30 * 24 * 60 * 60;
const MAX_STORES = 10;

export function readDeviceUserIds(request) {
  const val = readCookieValue(request, DEVICE_COOKIE);
  const obj = val ? verifyCookiePayload(val) : null;
  return Array.isArray(obj?.ids) ? obj.ids.filter((x) => typeof x === "string") : [];
}

export function clearDeviceCookie() {
  return `${DEVICE_COOKIE}=; Path=/oidc; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** This device's remembered stores that can still sign in, newest first. */
export async function rememberedStores(request, shop) {
  const ids = readDeviceUserIds(request);
  if (!ids.length) return [];
  const { default: prisma } = await import("../db.server");
  const users = await prisma.b2BUser.findMany({ where: { shop, id: { in: ids }, status: { not: "disabled" } } });
  return ids.map((id) => users.find((u) => u.id === id)).filter(Boolean);
}

export function deviceCookieWith(request, userId) {
  const ids = [userId, ...readDeviceUserIds(request).filter((x) => x !== userId)].slice(0, MAX_STORES);
  const val = signCookiePayload({ ids, exp: Math.floor(Date.now() / 1000) + DEVICE_TTL_SEC });
  return `${DEVICE_COOKIE}=${val}; Path=/oidc; Max-Age=${DEVICE_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
}
