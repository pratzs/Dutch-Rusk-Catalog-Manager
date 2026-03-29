// app/routes/api.catalog-rules.jsx
import prisma from "../db.server";

export async function loader({ request }) {
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
  let catalogId = url.searchParams.get("catalogId");
  let productId = url.searchParams.get("productId");

  // NORMALIZE catalogId only — DB stores catalog IDs as numeric strings.
  // productId must NOT be normalized — DB stores it as a full GID (gid://shopify/Product/xxx)
  // because that is what the admin app sends when saving overrides.
  if (catalogId && catalogId.includes("/")) catalogId = catalogId.split("/").pop();

  const responseHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
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

  // Normalize variant IDs to numeric — DB stores full GIDs (gid://shopify/ProductVariant/xxx)
  // but Shopify theme HTML only contains the numeric part (e.g. value="12345678").
  const rawVariantIds = override ? override.hiddenVariantIds : [];
  const hiddenVariantIds = rawVariantIds.map(id => id.includes("/") ? id.split("/").pop() : id);

  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds,
      hasOverride: !!override,
    }),
    { status: 200, headers: responseHeaders }
  );
}