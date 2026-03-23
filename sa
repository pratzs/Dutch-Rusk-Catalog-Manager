import prisma from "../db.server";

export async function loader({ request }) {
  const origin = request.headers.get("Origin") || "*";

  // 1. Handle Preflight OPTIONS requests for CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  let productId = url.searchParams.get("productId");

  // 2. Clean Product ID (Strip GID prefix if present)
  if (productId && productId.includes("gid://")) {
    productId = productId.split("/").pop();
  }

  const responseHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=60",
  };

  if (!catalogId) {
    return new Response(JSON.stringify({ error: "Missing catalogId" }), {
      status: 400,
      headers: responseHeaders,
    });
  }

  // 3. Fetch Data from Prisma
  const rule = await prisma.catalogRule.findUnique({
    where: { catalogId },
  });

  let override = null;
  if (productId) {
    override = await prisma.productOverride.findUnique({
      where: { catalogId_productId: { catalogId, productId } },
    });
  }

  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds: override ? override.hiddenVariantIds : [],
      hasOverride: !!override,
    }),
    {
      status: 200,
      headers: responseHeaders,
    }
  );
}