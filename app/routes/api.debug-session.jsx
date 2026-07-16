import { unauthenticated } from "../shopify.server";

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

  const url = new URL(request.url);
  let writeTest = null;
  if (url.searchParams.get("testWrite") === "1") {
    try {
      const { admin } = await unauthenticated.admin("dutchrusk.myshopify.com");
      const response = await admin.graphql(`
        mutation {
          customerUpdate(input: { id: "gid://shopify/Customer/9340090286393", note: "b2b-email-test-probe" }) {
            customer { id note }
            userErrors { field message }
          }
        }`);
      const data = await response.json();
      writeTest = data;
    } catch (err) {
      writeTest = { error: String(err.message || err) };
    }
  }

  let companyWriteTest = null;
  if (url.searchParams.get("testCompanyWrite") === "1") {
    try {
      const { admin } = await unauthenticated.admin("dutchrusk.myshopify.com");
      const response = await admin.graphql(`
        mutation {
          companyUpdate(companyId: "gid://shopify/Company/7197983033", input: { note: "b2b-email-test-probe" }) {
            company { id note }
            userErrors { field message }
          }
        }`);
      const data = await response.json();
      companyWriteTest = data;
    } catch (err) {
      companyWriteTest = { error: String(err.message || err) };
    }
  }

  return Response.json({
    envScopes: process.env.SCOPES ?? "(not set)",
    sessions: sessions.map(s => ({
      id: s.id,
      shop: s.shop,
      isOnline: s.isOnline,
      scope: s.scope,
      expires: s.expires,
    })),
    writeTest,
    companyWriteTest,
  });
}
