export async function loader({ request }) {
  const cronSecret = process.env.B2B_EMAIL_CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  if (!cronSecret || incomingSecret !== cronSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { default: prisma } = await import("../db.server");
  const sessions = await prisma.session.findMany({
    where: { shop: { contains: "dutchrusk" } },
    select: { id: true, shop: true, isOnline: true, scope: true, expires: true },
    orderBy: { id: "desc" },
  });

  return Response.json({
    envScopes: process.env.SCOPES ?? "(not set)",
    sessions: sessions.map(s => ({
      id: s.id,
      shop: s.shop,
      isOnline: s.isOnline,
      scope: s.scope,
      expires: s.expires,
    })),
  });
}
