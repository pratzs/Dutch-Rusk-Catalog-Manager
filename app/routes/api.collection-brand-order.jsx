// Manual trigger for the brand ordering. The logic lives in
// app/lib/brand-order.server.js so the scheduled job can run exactly the same
// code without going through HTTP.
//
// NOTE ON THE SCHEDULE: the recurring run is NOT this endpoint. A full pass
// takes tens of minutes across 90 collections, and Render's proxy ends a
// request that has sent nothing for 100 seconds, so a cron that curled this
// would be cut off part way through. The cron runs scripts/brand-order.mjs
// directly instead. This route is here for running it on demand.

export async function action({ request }) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";

  let shop, accessToken;
  if (cronSecret && incomingSecret === cronSecret) {
    const { default: prisma } = await import("../db.server");
    const session = await prisma.session.findFirst({
      where: { isOnline: false, accessToken: { not: "" } },
      orderBy: { id: "desc" },
    });
    if (!session) return Response.json({ error: "No session" }, { status: 500 });
    shop = session.shop;
    accessToken = session.accessToken;
  } else {
    const { authenticate } = await import("../shopify.server");
    const auth = await authenticate.admin(request);
    shop = auth.session.shop;
    const { default: prisma } = await import("../db.server");
    const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
    if (!session?.accessToken) return Response.json({ error: "No offline session" }, { status: 500 });
    accessToken = session.accessToken;
  }

  try {
    const { runBrandOrder } = await import("../lib/brand-order.server");
    return Response.json({ success: true, ...(await runBrandOrder(shop, accessToken)) });
  } catch (err) {
    console.error("[brand-order]", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
