// Scheduled brand ordering, run by the Render cron job.
//
// Deliberately NOT an HTTP call to the app. A full pass takes tens of minutes
// across 90 collections, and Render ends a request that has sent nothing for
// 100 seconds, so a cron that curled the endpoint would be cut off part way
// through and leave collections half ordered. This runs the same library code
// in the cron's own container instead, where nothing is waiting on it.
//
// Needs DATABASE_URL, so it can read the shop's offline access token from the
// same Session table the app uses.
import { runBrandOrder } from "../app/lib/brand-order.server.js";
import { getAdminToken } from "../app/lib/admin-token.server.js";

try {
  // Never read the token straight from Prisma: it expires hourly. See
  // app/lib/admin-token.server.js.
  const { shop, accessToken } = await getAdminToken();

  const started = Date.now();
  console.log(`[brand-order] starting for ${shop}`);
  const result = await runBrandOrder(shop, accessToken);
  const mins = ((Date.now() - started) / 60000).toFixed(1);

  console.log(
    `[brand-order] finished in ${mins} min: ${result.rearranged} rearranged, ` +
      `${result.alreadyCorrect} already correct, ${result.failed.length} failed`
  );

  // Exit non-zero on failures so Render reports the run as failed and notifies,
  // rather than a broken pass looking like a clean one.
  if (result.failed.length) {
    result.failed.forEach((f) => console.error(`[brand-order] FAILED ${f.collection}: ${f.error}`));
    process.exit(1);
  }
} catch (err) {
  console.error("[brand-order] fatal:", err);
  process.exit(1);
}
