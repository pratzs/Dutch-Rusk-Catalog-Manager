import { signCookiePayload, verifyCookiePayload } from "./crypto.server";

export const OIDC_REQUEST_COOKIE = "oidc_req";
export const OIDC_SESSION_COOKIE = "oidc_pending";
// 30 minutes: someone who steps away mid sign-in should not have to start again.
const OIDC_REQUEST_TTL_SEC = 30 * 60;
const OIDC_SESSION_TTL_SEC = 5 * 60;

export function readCookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1);
}

// One cookie per sign-in attempt (oidc_req_<rid>), named by an id carried in
// the sign-in page's URL and forms. A single shared cookie meant a second
// sign-in tab replaced the first one's request, and Shopify then rejected
// the first with "Invalid state parameter" (seen in testing, 28 Sept).
const RID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function readOidcRequestPayload(request, rid) {
  if (!rid || !RID_RE.test(rid)) return null;
  const val = readCookieValue(request, `${OIDC_REQUEST_COOKIE}_${rid}`);
  if (!val) return null;
  const obj = verifyCookiePayload(val);
  return obj && obj.rid === rid ? obj : null;
}

export function writeOidcRequestCookie(payload, rid) {
  const withExp = { ...payload, rid, exp: Math.floor(Date.now() / 1000) + OIDC_REQUEST_TTL_SEC };
  const val = signCookiePayload(withExp);
  return `${OIDC_REQUEST_COOKIE}_${rid}=${val}; Path=/oidc; Max-Age=${OIDC_REQUEST_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOidcRequestCookieFor(rid) {
  return `${OIDC_REQUEST_COOKIE}_${rid}=; Path=/oidc; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
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
