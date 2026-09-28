// Only Shopify's registered client and callback may use our login. Without
// this, /oidc/authorize would send a sign-in code to any address it was given.

export function allowedRedirectUris() {
  return String(process.env.OIDC_REDIRECT_URIS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedClient(clientId, redirectUri) {
  if (!process.env.OIDC_CLIENT_ID || clientId !== process.env.OIDC_CLIENT_ID) return false;
  return allowedRedirectUris().includes(redirectUri);
}
