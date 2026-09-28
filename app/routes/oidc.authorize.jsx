import { redirect } from "react-router";
import { writeOidcRequestCookie } from "../lib/oidc-request.server";

// OIDC authorization endpoint. Shopify redirects here with client_id, redirect_uri,
// response_type=code, scope, state, nonce, (optionally) code_challenge + method.
// We stash those params in a signed cookie and hand the user to the login form.

function collectParams(url) {
  const p = url.searchParams;
  const scope = p.get("scope") || "openid";
  if (!scope.split(/\s+/).includes("openid")) {
    return { error: "invalid_scope", desc: "openid scope is required" };
  }
  const responseType = p.get("response_type");
  if (responseType !== "code") {
    return { error: "unsupported_response_type", desc: "only response_type=code is supported" };
  }
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  if (!clientId || !redirectUri) {
    return { error: "invalid_request", desc: "client_id and redirect_uri are required" };
  }
  return {
    ok: true,
    payload: {
      clientId,
      redirectUri,
      scope,
      state: p.get("state") || "",
      nonce: p.get("nonce") || "",
      codeChallenge: p.get("code_challenge") || "",
      codeChallengeMethod: p.get("code_challenge_method") || "",
      loginHint: p.get("login_hint") || "",
      prompt: p.get("prompt") || "",
    },
  };
}

function errorRedirect(redirectUri, error, desc, state) {
  if (!redirectUri) {
    return new Response(JSON.stringify({ error, error_description: desc }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (desc) url.searchParams.set("error_description", desc);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}

function jsonError(error, desc) {
  console.warn(`[oidc.authorize] ${new Date().toISOString()} refused ${error}: ${desc}`);
  return new Response(JSON.stringify({ error, error_description: desc }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

// Sign in without a page when this device has already verified the store
// named in login_hint (a remembered store, 30 days). Returns null if not.
// Shopify sends prompt=login even on its single sign-on route (seen on the
// test store, 28 Sept), so this is applied whatever the prompt; with
// prompt=none a miss answers login_required instead of showing a page.
async function silentSignIn(request, oidcReq) {
  const [{ readDeviceUserIds }, { issueAuthCode }, { default: prisma }] = await Promise.all([
    import("../lib/oidc-device.server"),
    import("../lib/oidc-code.server"),
    import("../db.server"),
  ]);
  const ids = readDeviceUserIds(request);
  const email = String(oidcReq.loginHint || "").trim().toLowerCase();
  if (!ids.length || !email) return null;
  const shop = process.env.SHOP_DOMAIN || "dutchrusk.myshopify.com";
  const user = await prisma.b2BUser.findFirst({
    where: { shop, email, id: { in: ids }, status: { not: "disabled" } },
  });
  if (!user) return null;
  // Bookkeeping in the background: only the lookup above has to finish
  // before the switch carries on (it waited on three round trips, 825 ms
  // from far away on 28 Sept).
  const { recordAudit } = await import("../lib/b2b-auth.server");
  Promise.all([
    prisma.b2BUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    recordAudit({ shop, username: user.username, email: user.email, result: "sso_silent", ip: null, userAgent: request.headers.get("user-agent") || null }),
  ]).catch((err) => console.error("[oidc.authorize] silent sign-in bookkeeping failed:", err?.message ?? err));
  // Renew this device's memory on every use, so a store used daily never
  // falls back to a code 30 days after the last typed sign-in.
  const { deviceCookieWith } = await import("../lib/oidc-device.server");
  return redirect(await issueAuthCode({ user, oidcReq }), { headers: { "set-cookie": deviceCookieWith(request, user.id) } });
}

export const loader = async ({ request }) => {
  console.log(`[oidc.authorize] ${new Date().toISOString()}`);
  const url = new URL(request.url);
  const { isAllowedClient } = await import("../lib/oidc-client.server");
  // Checked before anything else, and never redirected: an unknown client or
  // callback must not receive codes or even error redirects.
  if (!isAllowedClient(url.searchParams.get("client_id"), url.searchParams.get("redirect_uri"))) {
    return jsonError("unauthorized_client", "unknown client_id or redirect_uri");
  }
  const parsed = collectParams(url);
  if (!parsed.ok) {
    return errorRedirect(url.searchParams.get("redirect_uri"), parsed.error, parsed.desc, url.searchParams.get("state"));
  }
  // A failed silent sign-in (database unreachable, say) falls back to the
  // normal sign-in page rather than an error page.
  const silent = parsed.payload.loginHint
    ? await silentSignIn(request, parsed.payload).catch((err) => {
        console.error("[oidc.authorize] silent sign-in failed, showing the sign-in page:", err?.message ?? err);
        return null;
      })
    : null;
  if (silent) return silent;
  if (parsed.payload.prompt.split(/\s+/).includes("none")) {
    return errorRedirect(parsed.payload.redirectUri, "login_required", "sign in needed", parsed.payload.state);
  }
  const { randomToken } = await import("../lib/crypto.server");
  const rid = randomToken(16);
  const cookie = writeOidcRequestCookie(parsed.payload, rid);
  // The issuer, not url.origin: behind a proxy (Render, a tunnel) the request
  // arrives as http, and the Secure oidc_req cookie would not be sent to an
  // http login page, so every sign-in would fail as "session expired".
  const { getIssuer } = await import("../lib/oidc.server");
  const loginUrl = new URL("/oidc/login", getIssuer());
  loginUrl.searchParams.set("r", rid);
  if (parsed.payload.loginHint) loginUrl.searchParams.set("email", parsed.payload.loginHint);
  return new Response(null, {
    status: 302,
    headers: { location: loginUrl.toString(), "set-cookie": cookie },
  });
};
