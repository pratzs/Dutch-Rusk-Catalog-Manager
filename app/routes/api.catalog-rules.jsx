// app/routes/api.catalog-rules.jsx
// Public API called by the storefront theme extension.
// Accepts ?locationId=<companyLocationGid> OR ?customerId=<numericId>&shop=<domain>
// as the primary catalog-resolution strategies, with ?catalogId=<numeric> as a last resort.
import prisma from "../db.server";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

// Resolve catalogId from a CompanyLocation GID via the LocationCatalogMap table.
async function catalogIdFromLocationGid(locationGid) {
  if (!locationGid) return null;
  const normalized = locationGid.includes("/")
    ? locationGid
    : `gid://shopify/CompanyLocation/${locationGid}`;
  const mapping = await prisma.locationCatalogMap.findUnique({
    where: { locationGid: normalized },
  });
  return mapping?.catalogId ?? null;
}

// Resolve catalogId by querying the Shopify Admin API for the customer's company
// locations, then mapping those locations via LocationCatalogMap.
// Uses the offline session token stored for the given shop.
async function catalogIdFromCustomer(customerId, shop) {
  if (!customerId || !shop) return null;

  const customerGid = customerId.includes("/")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });
  if (!session?.accessToken) {
    console.error("[CVH-API] No offline session found for shop:", shop);
    return null;
  }

  let gqlData;
  try {
    const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({
        query: `query($id: ID!) {
          customer(id: $id) {
            companyContactProfiles {
              company {
                locations(first: 50) { nodes { id } }
              }
            }
          }
        }`,
        variables: { id: customerGid },
      }),
    });
    gqlData = await res.json();
  } catch (e) {
    console.error("[CVH-API] Admin GraphQL fetch error:", e);
    return null;
  }

  if (gqlData.errors) {
    console.error("[CVH-API] GraphQL errors:", JSON.stringify(gqlData.errors));
    return null;
  }

  const profiles = gqlData.data?.customer?.companyContactProfiles ?? [];
  console.log("[CVH-API] Customer", customerGid, "→ profiles:", profiles.length);
  for (const profile of profiles) {
    for (const loc of profile.company?.locations?.nodes ?? []) {
      console.log("[CVH-API] Checking location:", loc.id);
      const id = await catalogIdFromLocationGid(loc.id);
      if (id) { console.log("[CVH-API] Resolved catalogId:", id); return id; }
    }
  }
  console.error("[CVH-API] No matching location in LocationCatalogMap for customer:", customerGid);
  return null;
}

export async function loader({ request }) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  // ── Strategy 1: explicit locationId (GID from Liquid) ─────────────────────
  let locationId = url.searchParams.get("locationId");
  let catalogId = locationId ? await catalogIdFromLocationGid(locationId) : null;

  // ── Strategy 2: catalogId passed directly ─────────────────────────────────
  if (!catalogId) {
    catalogId = url.searchParams.get("catalogId") || null;
    if (catalogId?.includes("/")) catalogId = catalogId.split("/").pop();
  }

  // ── Strategy 3: customerId + shop → Admin API lookup ──────────────────────
  if (!catalogId) {
    const customerId = url.searchParams.get("customerId");
    const shop = url.searchParams.get("shop");
    catalogId = await catalogIdFromCustomer(customerId, shop);
  }

  if (!catalogId) {
    return new Response(
      JSON.stringify({ error: "Could not resolve catalog" }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Normalize — DB stores numeric strings, snippets may pass full GIDs.
  if (catalogId.includes("/")) catalogId = catalogId.split("/").pop();

  const rule = await prisma.catalogRule.findUnique({ where: { catalogId } });

  let override = null;
  if (productId) {
    override = await prisma.productOverride.findUnique({
      where: { catalogId_productId: { catalogId, productId } },
    });
  }

  if (override) {
    // A product-level override is the COMPLETE list of hidden variants for this product.
    // Blanket hiddenVariantTypes are intentionally NOT applied — the override takes full
    // control, which is what allows showing a normally-blocked type (e.g. Shipper) for
    // a specific product.
    const hiddenVariantIds = (override.hiddenVariantIds || []).map((id) =>
      id.includes("/") ? id.split("/").pop() : id
    );
    return new Response(
      JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds, hasOverride: true }),
      { status: 200, headers: CORS_HEADERS }
    );
  }

  // No product-level override — apply the catalog's blanket pack type rules.
  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds: [],
      hasOverride: false,
    }),
    { status: 200, headers: CORS_HEADERS }
  );
}
