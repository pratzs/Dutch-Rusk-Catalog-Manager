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
import { PrismaClient } from "@prisma/client";
import { runBrandOrder } from "../app/lib/brand-order.server.js";

const prisma = new PrismaClient();

try {
  const session = await prisma.session.findFirst({
    where: { isOnline: false, accessToken: { not: "" } },
    orderBy: { id: "desc" },
  });
  if (!session) {
    console.error("[brand-order] no offline session in the database, nothing to do");
    process.exit(1);
  }

  const started = Date.now();
  console.log(`[brand-order] starting for ${session.shop}`);
  const result = await runBrandOrder(session.shop, session.accessToken);
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
} finally {
  await prisma.$disconnect();
}
