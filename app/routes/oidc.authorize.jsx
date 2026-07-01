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

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const parsed = collectParams(url);
  if (!parsed.ok) {
    return errorRedirect(url.searchParams.get("redirect_uri"), parsed.error, parsed.desc, url.searchParams.get("state"));
  }
  const cookie = writeOidcRequestCookie(parsed.payload);
  const loginUrl = new URL("/oidc/login", url.origin);
  if (parsed.payload.loginHint) loginUrl.searchParams.set("email", parsed.payload.loginHint);
  return new Response(null, {
    status: 302,
    headers: { location: loginUrl.toString(), "set-cookie": cookie },
  });
};
