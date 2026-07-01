import bcrypt from "bcryptjs";
import prisma from "../db.server";
import { sha256Hex, randomToken, randomOtp } from "./crypto.server";

const BCRYPT_COST = 12;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;

export async function hashPassword(plain) {
  if (!plain || plain.length < 8) throw new Error("Password must be at least 8 characters");
  return await bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return await bcrypt.compare(plain, hash);
}

export async function findUserByUsername(shop, username) {
  if (!shop || !username) return null;
  return await prisma.b2BUser.findUnique({
    where: { shop_username: { shop, username: username.trim().toLowerCase() } },
  });
}

export async function findUsersByEmail(shop, email) {
  if (!shop || !email) return [];
  return await prisma.b2BUser.findMany({
    where: { shop, email: email.trim().toLowerCase() },
  });
}

export async function recordAudit({ shop, username, email, result, ip, userAgent }) {
  try {
    await prisma.b2BLoginAudit.create({
      data: { shop, username: username ?? null, email: email ?? null, result, ip: ip ?? null, userAgent: userAgent ?? null },
    });
  } catch (err) {
    console.error("[b2b-auth] audit write failed:", err.message);
  }
}

export async function isRateLimited(shop, username) {
  if (!username) return false;
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const failures = await prisma.b2BLoginAudit.count({
    where: {
      shop,
      username,
      result: { in: ["bad_password", "otp_bad"] },
      createdAt: { gte: since },
    },
  });
  return failures >= RATE_LIMIT_MAX_FAILURES;
}

export async function createInviteToken(userId, ttlDays = 7) {
  const raw = randomToken(40);
  const tokenHash = sha256Hex(raw);
  await prisma.b2BPasswordResetToken.create({
    data: {
      userId,
      tokenHash,
      purpose: "invite",
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    },
  });
  return raw;
}

export async function createResetToken(userId, ttlHours = 24) {
  const raw = randomToken(40);
  const tokenHash = sha256Hex(raw);
  await prisma.b2BPasswordResetToken.create({
    data: {
      userId,
      tokenHash,
      purpose: "reset",
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
    },
  });
  return raw;
}

export async function consumeToken(rawToken, purpose) {
  if (!rawToken) return null;
  const tokenHash = sha256Hex(rawToken);
  const row = await prisma.b2BPasswordResetToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.usedAt) return null;
  if (row.expiresAt < new Date()) return null;
  await prisma.b2BPasswordResetToken.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });
  return row;
}

export async function issueOtp(userId, ttlMinutes = 10) {
  const code = randomOtp(6);
  await prisma.b2BOtpCode.create({
    data: {
      b2bUserId: userId,
      codeHash: sha256Hex(code),
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    },
  });
  return code;
}

export async function verifyOtp(userId, code) {
  const row = await prisma.b2BOtpCode.findFirst({
    where: {
      b2bUserId: userId,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;
  if (row.attempts >= 5) return false;
  const ok = row.codeHash === sha256Hex(String(code));
  if (ok) {
    await prisma.b2BOtpCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return true;
  }
  await prisma.b2BOtpCode.update({ where: { id: row.id }, data: { attempts: row.attempts + 1 } });
  return false;
}
