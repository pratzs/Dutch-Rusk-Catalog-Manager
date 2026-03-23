import prisma from "../db.server";

export async function loader({ request }) {
  // 1. Handle Preflight OPTIONS requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  let productId = url.searchParams.get("productId");

  if (!catalogId) {
    return new Response(JSON.stringify({ error: "Missing catalogId" }), {
      status: 400,
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": "*" 
      },
    });
  }

  // 2. Clean Product ID (Strip GID prefix if present)
  if (productId && productId.includes("gid://")) {
    productId = productId.split("/").pop();
  }

  // 3. Fetch Data
  const rule = await prisma.catalogRule.findUnique({
    where: { catalogId },
  });

  let override = null;
  if (productId) {
    override = await prisma.productOverride.findUnique({
      where: { catalogId_productId: { catalogId, productId } },
    });
  }

  // 4. Return Response with Full CORS Headers
  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds: override ? override.hiddenVariantIds : [],
      hasOverride: !!override,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}