import crypto from "node:crypto";

function requireAppSecret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "APP_SECRET env var must be set and at least 32 chars (used to encrypt OIDC signing keys and sign storefront cookies)"
    );
  }
  return s;
}

function deriveKey(purpose) {
  const secret = requireAppSecret();
  return crypto.createHash("sha256").update(`${secret}:${purpose}`).digest();
}

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function randomOtp(digits = 6) {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(digits, "0");
}

export function encryptSecret(plaintext) {
  const key = deriveKey("oidc-privkey");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(payload) {
  const [version, ivB64, tagB64, encB64] = String(payload).split(".");
  if (version !== "v1") throw new Error("Unknown encrypted-secret version");
  const key = deriveKey("oidc-privkey");
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const enc = Buffer.from(encB64, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function signCookiePayload(obj) {
  const key = deriveKey("storefront-cookie");
  const body = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyCookiePayload(signed) {
  if (typeof signed !== "string" || !signed.includes(".")) return null;
  const [body, mac] = signed.split(".");
  const key = deriveKey("storefront-cookie");
  const expected = crypto.createHmac("sha256", key).update(body).digest("base64url");
  const macBuf = Buffer.from(mac, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (macBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (obj.exp && obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
