import prisma from "../db.server";
import { createInviteToken, createResetToken } from "./b2b-auth.server";
import { sendB2BInvite, sendB2BReset } from "./brevo.server";

function firstName(displayName) {
  const parts = String(displayName || "").split(/\s+/).filter(Boolean);
  return parts[0] || "there";
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Sends invite or reset emails to a batch of users. Rate-limited to ~10/second
// to stay under Brevo's transactional API burst limit.
export async function sendBulkInvites({ shop, userIds, purpose = "invite" }) {
  const users = await prisma.b2BUser.findMany({ where: { shop, id: { in: userIds } } });
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  const failures = [];
  let sent = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    try {
      let raw;
      let actionUrl;
      if (purpose === "invite") {
        raw = await createInviteToken(user.id, 7);
        actionUrl = `${appUrl}/oidc/setup/${raw}`;
        await sendB2BInvite({
          email: user.email,
          firstName: firstName(user.storeDisplayName),
          storeDisplayName: user.storeDisplayName,
          username: user.username,
          actionUrl,
          expiresInDays: 7,
        });
      } else {
        raw = await createResetToken(user.id, 24);
        actionUrl = `${appUrl}/oidc/reset/${raw}`;
        await sendB2BReset({
          email: user.email,
          firstName: firstName(user.storeDisplayName),
          storeDisplayName: user.storeDisplayName,
          username: user.username,
          actionUrl,
          expiresInHours: 24,
        });
      }
      await prisma.b2BUser.update({
        where: { id: user.id },
        data: { invitedAt: new Date() },
      });
      sent++;
    } catch (err) {
      failures.push({ userId: user.id, username: user.username, error: err.message });
    }
    if (i % 10 === 9) await sleep(1100); // ~10/sec cadence
  }

  return { sent, failed: failures.length, failures };
}
