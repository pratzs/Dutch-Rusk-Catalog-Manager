import { signCookiePayload, verifyCookiePayload } from "./crypto.server";

export const OIDC_REQUEST_COOKIE = "oidc_req";
export const OIDC_SESSION_COOKIE = "oidc_pending";
const OIDC_REQUEST_TTL_SEC = 10 * 60;
const OIDC_SESSION_TTL_SEC = 5 * 60;

export function readCookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1);
}

export function readOidcRequestPayload(request) {
  const val = readCookieValue(request, OIDC_REQUEST_COOKIE);
  if (!val) return null;
  return verifyCookiePayload(val);
}

export function writeOidcRequestCookie(payload) {
  const withExp = { ...payload, exp: Math.floor(Date.now() / 1000) + OIDC_REQUEST_TTL_SEC };
  const val = signCookiePayload(withExp);
  return `${OIDC_REQUEST_COOKIE}=${val}; Path=/; Max-Age=${OIDC_REQUEST_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOidcRequestCookie() {
  return `${OIDC_REQUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readOidcSessionPayload(request) {
  const val = readCookieValue(request, OIDC_SESSION_COOKIE);
  if (!val) return null;
  return verifyCookiePayload(val);
}

export function writeOidcSessionCookie(payload) {
  const withExp = { ...payload, exp: Math.floor(Date.now() / 1000) + OIDC_SESSION_TTL_SEC };
  const val = signCookiePayload(withExp);
  return `${OIDC_SESSION_COOKIE}=${val}; Path=/; Max-Age=${OIDC_SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOidcSessionCookie() {
  return `${OIDC_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
