// app/routes/api.catalog-rules.jsx
import prisma from "../db.server";

export async function loader({ request }) {
  const origin = request.headers.get("Origin") || "*";

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const url = new URL(request.url);
  let catalogId = url.searchParams.get("catalogId");
  let productId = url.searchParams.get("productId");

  // NORMALIZE: Extract only the numeric ID from ANY GID format
  if (catalogId && catalogId.includes("/")) catalogId = catalogId.split("/").pop();
  if (productId && productId.includes("/")) productId = productId.split("/").pop();

  const responseHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store", 
  };

  if (!catalogId) {
    return new Response(JSON.stringify({ error: "Missing catalogId" }), {
      status: 400,
      headers: responseHeaders,
    });
  }

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
    { status: 200, headers: responseHeaders }
  );
}