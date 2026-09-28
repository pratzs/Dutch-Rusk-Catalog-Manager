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

async function issueRefreshToken({ b2bUserId, clientId, scope, background }) {
  const raw = randomToken(32);
  const save = prisma.oidcRefreshToken.create({
    data: {
      tokenHash: sha256Hex(raw),
      b2bUserId,
      clientId,
      scope,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  if (background) save.catch((err) => console.error("[oidc.token] refresh token save failed:", err?.message ?? err));
  else await save;
  return raw;
}

async function tokensForUser({ user, clientId, scope, nonce, includeRefresh, previousRefreshRow, background }) {
  // The refresh token is random; its hashed copy is saved in the background
  // on a first sign-in (background: true), so the reply never waits on the
  // database. Shopify only uses it much later.
  const refreshPromise = includeRefresh ? issueRefreshToken({ b2bUserId: user.id, clientId, scope, background }) : null;
  // Only who they are: the store's own Shopify customer (sub) and its email.
  // No name, phone, address or tags: Ostendo owns customer data, and if
  // "Sync customer data" were ever switched on in Shopify these claims would
  // overwrite it (store names as first and last names, extra tags).
  const idToken = await signIdToken({
    audience: clientId,
    subject: user.customerGid,
    email: user.email,
    emailVerified: true,
    nonce: nonce || undefined,
  });

  // Fire-and-forget the storefront pre-select metafield write. Shopify's token
  // exchange has a short timeout (~5-10s); a slow Admin GraphQL call here
  // would break login. We don't await this — the metafield lands after the
  // token response is already returned, which is fine because the theme block
  // reads it on the storefront's NEXT page load.
  // Off unless OIDC_PRESELECT=on: the old pre-select route never runs (see
  // docs/OWN-LOGIN-AND-STORE-SWITCH-PLAN.md), and a test store has no app.
  if (process.env.OIDC_PRESELECT === "on") writeTargetLocationMetafield({
    shop: process.env.SHOP_DOMAIN || "dutchrusk.myshopify.com",
    customerGid: user.customerGid,
    companyLocationGid: user.companyLocationGid,
    username: user.username,
  }).catch((err) => console.error("[oidc.token] pre-select metafield write failed:", err.message));

  // Signed so /oidc/userinfo can answer for it without storing anything.
  const { signCookiePayload } = await import("../lib/crypto.server");
  const accessToken = signCookiePayload({ t: "at", uid: user.id, aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600 });
  const response = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    id_token: idToken,
    scope,
  };

  if (includeRefresh) {
    response.refresh_token = await refreshPromise;
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

    const t0 = Date.now();
    const { readAuthCode, consumeAuthCode } = await import("../lib/oidc-code.server");
    // Checked from its own signature, no database read (see oidc-code.server.js).
    const p = readAuthCode(code);
    if (!p) return jsonError(400, "invalid_grant", "code invalid or expired");
    if (p.ru !== redirectUri) return jsonError(400, "invalid_grant", "redirect_uri mismatch");
    if (p.cid !== process.env.OIDC_CLIENT_ID) return jsonError(400, "invalid_grant", "client_id mismatch");
    if (!verifyCodeChallenge(codeVerifier, p.cc, p.ccm)) return jsonError(400, "invalid_grant", "code_verifier mismatch");

    const user = { id: p.uid, customerGid: p.sub, email: p.em, username: p.un, storeDisplayName: p.sd, catalogGroup: p.cat, companyLocationGid: p.loc };
    // Recording the code as used and building the tokens run together; the
    // tokens are only returned if this was the code's first use.
    if (!consumeAuthCode(p)) return jsonError(400, "invalid_grant", "code already used");
    const payload = await tokensForUser({ user, clientId: p.cid, scope: p.sc, nonce: p.n, includeRefresh: true, background: true });
    console.log(`[oidc.token] ${new Date().toISOString()} code grant in ${Date.now() - t0} ms`);
    return jsonOk(payload);
  }

  if (grantType === "refresh_token") {
    const raw = String(form.get("refresh_token") || "");
    if (!raw) return jsonError(400, "invalid_request", "refresh_token required");
    const t0 = Date.now();
    // One round trip: use up the token (only if unused and unexpired) and read
    // its account in the same statement. Two refreshes racing with one token:
    // exactly one gets a row back. Each separate query from far away cost
    // about 0.45 s (1 to 2 s total on 28 Sept, too close to Shopify's limit).
    const rows = await prisma.$queryRaw`
      WITH t AS (
        UPDATE "OidcRefreshToken" SET "usedAt" = NOW()
        WHERE "tokenHash" = ${sha256Hex(raw)} AND "usedAt" IS NULL AND "expiresAt" > NOW()
        RETURNING "b2bUserId", "clientId", "scope"
      )
      SELECT u.*, t."clientId" AS "rtClientId", t."scope" AS "rtScope" FROM t JOIN "B2BUser" u ON u."id" = t."b2bUserId"`;
    const found = rows[0];
    if (!found) return jsonError(400, "invalid_grant", "refresh_token not found, already used or expired");
    if (found.rtClientId !== process.env.OIDC_CLIENT_ID) return jsonError(400, "invalid_grant", "client_id mismatch");
    if (found.status === "disabled") return jsonError(400, "invalid_grant", "account disabled");
    const user = found;
    const row = { clientId: found.rtClientId, scope: found.rtScope };

    const payload = await tokensForUser({
      user,
      clientId: row.clientId,
      scope: row.scope,
      includeRefresh: true,
      background: true,
    });
    console.log(`[oidc.token] ${new Date().toISOString()} refresh grant in ${Date.now() - t0} ms`);
    return jsonOk(payload);
  }

  return jsonError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
};

export const loader = () => jsonError(405, "invalid_request", "POST required");
