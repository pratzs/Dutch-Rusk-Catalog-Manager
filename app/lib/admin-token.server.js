import prisma from "../db.server.js";

/**
 * An offline admin access token that is actually valid right now.
 *
 * The app runs with `future: { expiringOfflineAccessTokens: true }`, so the
 * token in the Session table EXPIRES -- about hourly. The Shopify library
 * refreshes it whenever an authenticated request comes through (an admin page
 * load, a webhook), which is why it is usually fine during the working day and
 * stale overnight.
 *
 * Anything that reads `session.accessToken` straight out of Prisma therefore
 * works in the daytime and fails at night. That is exactly what the scheduled
 * jobs were doing: Deal Entitlement Sync failed 9 of 20 runs on 15 Sept, all of
 * them between 13:07 and 18:07 UTC (1am-6am NZ), every one with
 * "[API] Invalid API key or access token", and every one recovered by itself
 * once the morning's orders started refreshing the token again. The 15-minute
 * pricing health check was failing the same way, silently.
 *
 * `unauthenticated.admin()` is the supported way to get a session outside a
 * request: it performs the token exchange when the stored token has expired.
 * Every scheduled job should go through here rather than touching Prisma.
 *
 * @param {string} [shop] Defaults to SHOP_DOMAIN, else the stored session's shop.
 * @returns {Promise<{ shop: string, accessToken: string, admin: any }>}
 */
export async function getAdminToken(shop) {
  const { unauthenticated } = await import("../shopify.server.js");

  let domain = shop ?? process.env.SHOP_DOMAIN ?? null;
  if (!domain) {
    const stored = await prisma.session.findFirst({
      where: { isOnline: false, accessToken: { not: "" } },
      orderBy: { id: "desc" },
    });
    if (!stored) throw new Error("no offline session in the database, and SHOP_DOMAIN is not set");
    domain = stored.shop;
  }

  const { admin, session } = await unauthenticated.admin(domain);
  if (!session?.accessToken) throw new Error(`could not obtain an admin token for ${domain}`);

  return { shop: domain, accessToken: session.accessToken, admin };
}
