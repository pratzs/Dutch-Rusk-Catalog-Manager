import crypto from "node:crypto";
import prisma from "../db.server";
import { signIdToken } from "../lib/oidc.server";
import { randomToken, sha256Hex } from "../lib/crypto.server";
import { writeTargetLocationMetafield } from "../lib/storefront-preselect.server";

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function jsonError(status, error, description) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "pragma": "no-cache",
    },
  });
}

function jsonOk(payload) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "pragma": "no-cache",
    },
  });
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
}

function verifyCodeChallenge(codeVerifier, storedChallenge, method) {
  if (!storedChallenge) return true; // PKCE was not used
  if (method !== "S256") return false;
  if (!codeVerifier) return false;
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const computed = hash.toString("base64url");
  return computed === storedChallenge;
}

function authenticateClient(request, form) {
  const expectedId = process.env.OIDC_CLIENT_ID;
  const expectedSecret = process.env.OIDC_CLIENT_SECRET;
  if (!expectedId || !expectedSecret) {
    throw new Error("OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set (registered in Shopify admin under Third-party identity provider)");
  }

  const basic = parseBasicAuth(request.headers.get("authorization"));
  const bodyId = form.get("client_id");
  const bodySecret = form.get("client_secret");

  let clientId, clientSecret;
  if (basic) {
    clientId = basic.clientId;
    clientSecret = basic.clientSecret;
  } else {
    clientId = bodyId;
    clientSecret = bodySecret;
  }

  if (clientId !== expectedId) return false;
  if (typeof clientSecret !== "string") return false;
  const a = Buffer.from(clientSecret);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function issueRefreshToken({ b2bUserId, clientId, scope }) {
  const raw = randomToken(32);
  await prisma.oidcRefreshToken.create({
    data: {
      tokenHash: sha256Hex(raw),
      b2bUserId,
      clientId,
      scope,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return raw;
}

async function tokensForUser({ user, clientId, scope, nonce, includeRefresh, previousRefreshRow }) {
  const tags = ["b2b-general", user.catalogGroup ? `b2b-${user.catalogGroup.toLowerCase().replace(/\s+/g, "-")}` : null].filter(Boolean);
  const idToken = await signIdToken({
    audience: clientId,
    subject: user.customerGid,
    email: user.email,
    emailVerified: true,
    nonce: nonce || undefined,
    extraClaims: {
      given_name: (user.storeDisplayName || "").split(" ").slice(0, -1).join(" ") || null,
      family_name: (user.storeDisplayName || "").split(" ").slice(-1)[0] || null,
      "urn:shopify:customer:tags": tags,
      "urn:dutchrusk:location_gid": user.companyLocationGid,
      "urn:dutchrusk:username": user.username,
    },
  });

  // Fire-and-forget the storefront pre-select metafield write. Shopify's token
  // exchange has a short timeout (~5-10s); a slow Admin GraphQL call here
  // would break login. We don't await this — the metafield lands after the
  // token response is already returned, which is fine because the theme block
  // reads it on the storefront's NEXT page load.
  writeTargetLocationMetafield({
    shop: process.env.SHOP_DOMAIN || "dutchrusk.myshopify.com",
    customerGid: user.customerGid,
    companyLocationGid: user.companyLocationGid,
    username: user.username,
  }).catch((err) => console.error("[oidc.token] pre-select metafield write failed:", err.message));

  const accessToken = randomToken(32);
  const response = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    id_token: idToken,
    scope,
  };

  if (includeRefresh) {
    response.refresh_token = await issueRefreshToken({ b2bUserId: user.id, clientId, scope });
    // Consume the old refresh token (single-use rotation) after issuing the new one.
    if (previousRefreshRow) {
      await prisma.oidcRefreshToken.update({
        where: { id: previousRefreshRow.id },
        data: { usedAt: new Date() },
      });
    }
  }
  return response;
}

export const action = async ({ request }) => {
  if (request.method !== "POST") return jsonError(405, "invalid_request", "POST required");
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return jsonError(400, "invalid_request", "Content-Type must be application/x-www-form-urlencoded");
  }
  const form = await request.formData();
  const grantType = String(form.get("grant_type") || "");

  try {
    if (!authenticateClient(request, form)) {
      return jsonError(401, "invalid_client", "client_id/client_secret mismatch");
    }
  } catch (err) {
    console.error("[oidc.token] client auth misconfig:", err.message);
    return jsonError(500, "server_error", "IdP misconfigured");
  }

  if (grantType === "authorization_code") {
    const code = String(form.get("code") || "");
    const redirectUri = String(form.get("redirect_uri") || "");
    const codeVerifier = String(form.get("code_verifier") || "");

    const codeRow = await prisma.oidcAuthCode.findUnique({ where: { code } });
    if (!codeRow) return jsonError(400, "invalid_grant", "code not found");
    if (codeRow.consumedAt) return jsonError(400, "invalid_grant", "code already consumed");
    if (codeRow.expiresAt < new Date()) return jsonError(400, "invalid_grant", "code expired");
    if (codeRow.redirectUri !== redirectUri) return jsonError(400, "invalid_grant", "redirect_uri mismatch");
    if (codeRow.clientId !== process.env.OIDC_CLIENT_ID) return jsonError(400, "invalid_grant", "client_id mismatch");
    if (!verifyCodeChallenge(codeVerifier, codeRow.codeChallenge, codeRow.codeChallengeMethod)) {
      return jsonError(400, "invalid_grant", "code_verifier mismatch");
    }

    const user = await prisma.b2BUser.findUnique({ where: { id: codeRow.b2bUserId } });
    if (!user) return jsonError(400, "invalid_grant", "user not found");

    await prisma.oidcAuthCode.update({
      where: { id: codeRow.id },
      data: { consumedAt: new Date() },
    });

    const payload = await tokensForUser({
      user,
      clientId: codeRow.clientId,
      scope: codeRow.scope,
      nonce: codeRow.nonce,
      includeRefresh: true,
    });
    return jsonOk(payload);
  }

  if (grantType === "refresh_token") {
    const raw = String(form.get("refresh_token") || "");
    if (!raw) return jsonError(400, "invalid_request", "refresh_token required");
    const row = await prisma.oidcRefreshToken.findUnique({ where: { tokenHash: sha256Hex(raw) } });
    if (!row) return jsonError(400, "invalid_grant", "refresh_token not found");
    if (row.usedAt) return jsonError(400, "invalid_grant", "refresh_token already consumed");
    if (row.expiresAt < new Date()) return jsonError(400, "invalid_grant", "refresh_token expired");
    if (row.clientId !== process.env.OIDC_CLIENT_ID) return jsonError(400, "invalid_grant", "client_id mismatch");

    const user = await prisma.b2BUser.findUnique({ where: { id: row.b2bUserId } });
    if (!user) return jsonError(400, "invalid_grant", "user not found");
    if (user.status === "disabled") return jsonError(400, "invalid_grant", "account disabled");

    const payload = await tokensForUser({
      user,
      clientId: row.clientId,
      scope: row.scope,
      includeRefresh: true,
      previousRefreshRow: row,
    });
    return jsonOk(payload);
  }

  return jsonError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
};

export const loader = () => jsonError(405, "invalid_request", "POST required");
