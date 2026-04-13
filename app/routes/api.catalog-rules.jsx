// app/routes/api.catalog-rules.jsx
// Public API called by the storefront theme extension.
// Accepts either ?catalogId=<numeric> OR ?locationId=<companyLocationGid>
// so the snippet can pass the customer's company location ID directly.
import prisma from "../db.server";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

export async function loader({ request }) {
  const url = new URL(request.url);
  let catalogId = url.searchParams.get("catalogId");
  let locationId = url.searchParams.get("locationId");
  const productId = url.searchParams.get("productId");

  // Resolve catalogId from locationId when the snippet sends a company location GID.
  if (!catalogId && locationId) {
    // Normalize — some themes may strip the GID prefix and pass just the numeric part.
    if (!locationId.includes("/")) {
      locationId = `gid://shopify/CompanyLocation/${locationId}`;
    }
    const mapping = await prisma.locationCatalogMap.findUnique({
      where: { locationGid: locationId },
    });
    if (mapping) catalogId = mapping.catalogId;
  }

  // Normalize catalogId — DB stores numeric strings, snippets may pass full GIDs.
  if (catalogId && catalogId.includes("/")) catalogId = catalogId.split("/").pop();

  if (!catalogId) {
    return new Response(
      JSON.stringify({ error: "Missing catalogId or locationId" }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const rule = await prisma.catalogRule.findUnique({ where: { catalogId } });

  let override = null;
  if (productId) {
    override = await prisma.productOverride.findUnique({
      where: { catalogId_productId: { catalogId, productId } },
    });
  }

  // Normalize variant IDs to numeric — DB stores full GIDs but theme HTML uses numeric values.
  const rawVariantIds = override ? override.hiddenVariantIds : [];
  const hiddenVariantIds = rawVariantIds.map((id) =>
    id.includes("/") ? id.split("/").pop() : id
  );

  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds,
      hasOverride: !!override,
    }),
    { status: 200, headers: CORS_HEADERS }
  );
}
