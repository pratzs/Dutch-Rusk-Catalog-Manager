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
import { adminGql, syncDealLocations } from "../app/lib/brand-order.server.js";
import { getAdminToken } from "../app/lib/admin-token.server.js";


console.log("[deal-entitlement] starting");

try {
  // Never read the token straight from Prisma: it expires hourly. See
  // app/lib/admin-token.server.js for what that used to do to this job.
  const { shop, accessToken } = await getAdminToken();

  const started = Date.now();
  const result = await syncDealLocations(adminGql(shop, accessToken));
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
}
