// Rebuild only the BOGO deal entitlement list.
//
// Split out from the full brand-order pass on purpose. Deciding who may see a
// deal is a handful of API calls and takes seconds, while the collection
// ordering takes minutes, so this runs hourly and the ordering stays on its
// 48-hour schedule. That means a catalog change Ryan makes in the admin
// applies within the hour instead of within two days.
//
// Writes only when the list has actually changed, so a quiet hour is free.
//
// Logs a line the moment it starts. This job silently did nothing for hours
// while Render reported every run as successful: the cron command was
// "npx prisma generate && node scripts/...", Render ran it without a shell,
// so npx took the tail as extra arguments to `prisma generate`, generated the
// client and exited 0. Prisma's output in the log looked like progress. With a
// start line, output that stops after Prisma is obviously wrong.
import { PrismaClient } from "@prisma/client";
import { adminGql, syncDealLocations } from "../app/lib/brand-order.server.js";

const prisma = new PrismaClient();

console.log("[deal-entitlement] starting");

try {
  const session = await prisma.session.findFirst({
    where: { isOnline: false, accessToken: { not: "" } },
    orderBy: { id: "desc" },
  });
  if (!session) {
    console.error("[deal-entitlement] no offline session in the database, nothing to do");
    process.exit(1);
  }

  const started = Date.now();
  const result = await syncDealLocations(adminGql(session.shop, session.accessToken));
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (result.dealLocations === null) {
    // syncDealLocations already logged why; it deliberately leaves the existing
    // list alone rather than emptying it, which would revoke every deal.
    console.error(`[deal-entitlement] could not rebuild the list after ${secs}s, left the existing one in place`);
    process.exit(1);
  }
  console.log(`[deal-entitlement] done in ${secs}s: ${result.dealLocations} entitled location(s)`);
} catch (err) {
  console.error("[deal-entitlement] fatal:", err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
