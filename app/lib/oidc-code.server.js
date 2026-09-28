// One-time authorization codes for Shopify's token exchange.
//
// Shopify gives /oidc/token only a few seconds, and the database is a long
// round trip away (a lookup-based code took 1.3 to 3.3 s on 28 Sept, over
// Shopify's limit). So a code is self-contained: a signed, 5-minute payload
// with everything the token needs. The token endpoint checks the signature
// without reading anything, and records the code's id once (a unique insert)
// so it can never be redeemed twice.

import { randomToken, signCookiePayload, verifyCookiePayload } from "./crypto.server";

const CODE_TTL_SEC = 5 * 60;

export async function issueAuthCode({ user, oidcReq }) {
  const payload = {
    t: "code",
    jti: randomToken(16),
    uid: user.id,
    sub: user.customerGid,
    em: user.email,
    un: user.username,
    sd: user.storeDisplayName,
    cat: user.catalogGroup,
    loc: user.companyLocationGid,
    cid: oidcReq.clientId,
    ru: oidcReq.redirectUri,
    n: oidcReq.nonce || null,
    sc: oidcReq.scope,
    cc: oidcReq.codeChallenge || null,
    ccm: oidcReq.codeChallengeMethod || null,
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_SEC,
  };
  const cb = new URL(oidcReq.redirectUri);
  cb.searchParams.set("code", signCookiePayload(payload));
  if (oidcReq.state) cb.searchParams.set("state", oidcReq.state);
  return cb.toString();
}

/** The code's payload if the signature and expiry are good, else null. */
export function readAuthCode(code) {
  const p = verifyCookiePayload(String(code || ""));
  return p && p.t === "code" && p.jti && p.uid ? p : null;
}

// Used code ids, kept in memory until they expire. Checked synchronously so
// the token exchange never waits on the database (the app runs as a single
// instance; the database copy below is written in the background).
const usedCodes = new Map(); // jti -> expiry ms

/** Record the code as used. False if it was already used (replay). */
export function consumeAuthCode(p) {
  const now = Date.now();
  for (const [k, exp] of usedCodes) if (exp < now) usedCodes.delete(k);
  if (usedCodes.has(p.jti)) return false;
  usedCodes.set(p.jti, p.exp * 1000);
  recordUsedCode(p).catch((err) => console.error("[oidc] could not record used code:", err?.message ?? err));
  return true;
}

async function recordUsedCode(p) {
  const { default: prisma } = await import("../db.server");
  try {
    await prisma.oidcAuthCode.create({
      data: {
        code: p.jti,
        b2bUserId: p.uid,
        customerGid: p.sub,
        companyLocationGid: p.loc || "",
        clientId: p.cid,
        redirectUri: p.ru,
        nonce: p.n,
        scope: p.sc,
        expiresAt: new Date(p.exp * 1000),
        consumedAt: new Date(),
      },
    });
  } catch (err) {
    if (err?.code !== "P2002") throw err;
  }
}
