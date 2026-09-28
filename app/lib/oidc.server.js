import crypto from "node:crypto";
import { SignJWT, exportJWK, importPKCS8 } from "jose";
import prisma from "../db.server";
import { encryptSecret, decryptSecret } from "./crypto.server";

const SIGNING_ALG = "RS256";
const KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function getIssuer() {
  const url = process.env.SHOPIFY_APP_URL || process.env.APP_URL;
  if (!url) throw new Error("SHOPIFY_APP_URL (or APP_URL) env var required for OIDC issuer");
  return url.replace(/\/$/, "");
}

async function generateRsaKeyPair() {
  return await new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      "rsa",
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
      (err, publicKey, privateKey) => {
        if (err) return reject(err);
        resolve({ publicKeyPem: publicKey, privateKeyPem: privateKey });
      }
    );
  });
}

async function createSigningKey() {
  const { publicKeyPem, privateKeyPem } = await generateRsaKeyPair();
  const publicKeyObj = crypto.createPublicKey(publicKeyPem);
  const jwk = await exportJWK(publicKeyObj);
  const kid = crypto.createHash("sha256").update(JSON.stringify(jwk)).digest("base64url").slice(0, 16);
  jwk.kid = kid;
  jwk.alg = SIGNING_ALG;
  jwk.use = "sig";

  return await prisma.oidcSigningKey.create({
    data: {
      kid,
      algorithm: SIGNING_ALG,
      publicJwk: jwk,
      privateKeyEnc: encryptSecret(privateKeyPem),
      activeForSigning: true,
    },
  });
}

// The token endpoint has a few seconds before Shopify gives up, and the
// database is a long round trip away, so the active key (and its imported
// private key) is kept in memory for a few minutes instead of being read and
// decrypted on every sign-in (3.3 s measured on 28 Sept, over the limit).
let keyCache = null; // { key, privateKey, at }
// OIDC_KEY_CACHE_MS only shortens this for testing the stale path.
const KEY_CACHE_MS = Number(process.env.OIDC_KEY_CACHE_MS) || 5 * 60 * 1000;

/** Keep the database connection open and the key loaded, so no sign-in pays for a cold start. */
export async function warmOidc() {
  // Several at once: the token exchange runs two writes in parallel, and a
  // second connection opened on demand costs over a second to Oregon.
  await Promise.all([1, 2, 3].map(() => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));
  // Replaced in place, never emptied first, so a sign-in during the refresh
  // still uses the copy in memory.
  await loadKey();
  await loadJwks();
  // One practice signature loads the signing code, so the first real
  // sign-in after a restart is as quick as the rest.
  await signIdToken({ audience: "warm-up", subject: "warm-up", email: "warm-up@example.invalid", emailVerified: false, expiresInSec: 60 });
}

// A sign-in never waits on the database for the key once it is in memory:
// an old copy is used straight away and refreshed in the background. Waiting
// on a reload cost 893 ms on 28 Sept, and Shopify gave up (its limit on the
// token exchange is under a second).
let keyLoading = null;
function loadKey() {
  if (!keyLoading) {
    keyLoading = (async () => {
      const key = await getActiveSigningKey();
      const privateKey = await importPKCS8(decryptSecret(key.privateKeyEnc), SIGNING_ALG);
      keyCache = { key, privateKey, at: Date.now() };
      return keyCache;
    })().finally(() => { keyLoading = null; });
  }
  return keyLoading;
}

async function activeKeyAndPrivate() {
  if (keyCache) {
    if (Date.now() - keyCache.at > KEY_CACHE_MS) loadKey().catch((err) => console.error("[oidc] key refresh failed:", err?.message ?? err));
    return keyCache;
  }
  return loadKey();
}

export async function getActiveSigningKey() {
  let key = await prisma.oidcSigningKey.findFirst({
    where: { activeForSigning: true },
    orderBy: { createdAt: "desc" },
  });
  if (!key) {
    key = await createSigningKey();
    return key;
  }
  const age = Date.now() - new Date(key.createdAt).getTime();
  if (age > KEY_TTL_MS) {
    await prisma.oidcSigningKey.update({
      where: { id: key.id },
      data: { activeForSigning: false, rotatedAt: new Date() },
    });
    key = await createSigningKey();
  }
  return key;
}

// Shopify fetches the public keys straight after the token exchange to check
// the signature (2.1 s and 0.7 s from the database on 28 Sept), so they are
// kept in memory too. Refreshed by the warm-up, and whenever the signing key
// in memory changes, so a new key is always published before it is used.
let jwksCache = null; // { body, kid, at }

let jwksLoading = null;
function loadJwks() {
  if (!jwksLoading) {
    jwksLoading = (async () => {
      const kid = keyCache?.key?.kid;
      const body = await loadPublicJwks();
      jwksCache = { body, kid, at: Date.now() };
      return body;
    })().finally(() => { jwksLoading = null; });
  }
  return jwksLoading;
}

export async function getPublicJwks() {
  const kid = keyCache?.key?.kid;
  // Same key as the one signing: serve from memory, refresh in the background
  // if old. A new signing key (rotation) waits for the fresh list, so a token
  // is never signed with a key Shopify cannot find.
  if (jwksCache && (!kid || jwksCache.kid === kid)) {
    if (Date.now() - jwksCache.at > KEY_CACHE_MS) loadJwks().catch((err) => console.error("[oidc] jwks refresh failed:", err?.message ?? err));
    return jwksCache.body;
  }
  return loadJwks();
}

async function loadPublicJwks() {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // keep rotated keys 2h for in-flight tokens
  const keys = await prisma.oidcSigningKey.findMany({
    where: {
      OR: [
        { activeForSigning: true },
        { rotatedAt: { gte: cutoff } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  return { keys: keys.map((k) => k.publicJwk) };
}

export async function signIdToken({
  audience,
  subject,
  email,
  emailVerified,
  nonce,
  extraClaims = {},
  expiresInSec = 3600,
}) {
  const { key, privateKey } = await activeKeyAndPrivate();

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    email,
    email_verified: emailVerified === true,
    ...extraClaims,
  };
  if (nonce) payload.nonce = nonce;

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: SIGNING_ALG, kid: key.kid, typ: "JWT" })
    .setIssuer(getIssuer())
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSec)
    .sign(privateKey);
}

export function buildDiscoveryDocument() {
  const iss = getIssuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oidc/authorize`,
    token_endpoint: `${iss}/oidc/token`,
    jwks_uri: `${iss}/oidc/jwks.json`,
    userinfo_endpoint: `${iss}/oidc/userinfo`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [SIGNING_ALG],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "email", "email_verified"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  };
}
