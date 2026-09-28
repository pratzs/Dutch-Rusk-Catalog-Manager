// OIDC userinfo endpoint (advertised in discovery). Answers for the access
// token issued by /oidc/token, which is signed rather than stored.

import { verifyCookiePayload } from "../lib/crypto.server";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function answer(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const claims = token ? verifyCookiePayload(token) : null;
  if (!claims || claims.t !== "at" || !claims.uid) return json(401, { error: "invalid_token" });
  const { default: prisma } = await import("../db.server");
  const user = await prisma.b2BUser.findUnique({ where: { id: claims.uid } });
  if (!user || user.status === "disabled") return json(401, { error: "invalid_token" });
  return json(200, { sub: user.customerGid, email: user.email, email_verified: true });
}

export const loader = ({ request }) => answer(request);
export const action = ({ request }) => answer(request);
