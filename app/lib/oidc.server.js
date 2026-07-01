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

export async function getPublicJwks() {
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
  const key = await getActiveSigningKey();
  const privateKeyPem = decryptSecret(key.privateKeyEnc);
  const privateKey = await importPKCS8(privateKeyPem, SIGNING_ALG);

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
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "nonce",
      "email",
      "email_verified",
      "urn:shopify:customer:tags",
      "urn:dutchrusk:location_gid",
      "urn:dutchrusk:username",
    ],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  };
}
