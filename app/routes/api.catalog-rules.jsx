// app/routes/api.catalog-rules.jsx

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

async function catalogIdFromLocationGid(prisma, locationGid) {
  if (!locationGid) return null;
  const normalized = locationGid.includes("/") ? locationGid : `gid://shopify/CompanyLocation/${locationGid}`;
  const mapping = await prisma.locationCatalogMap.findUnique({ where: { locationGid: normalized } });
  return mapping?.catalogId ?? null;
}

async function catalogIdFromCustomer(prisma, customerId, shop) {
  if (!customerId || !shop) return null;
  const customerGid = customerId.includes("/") ? customerId : `gid://shopify/Customer/${customerId}`;
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) return null;

  try {
    const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({
        query: `query($id: ID!) { customer(id: $id) { companyContactProfiles { company { locations(first: 50) { nodes { id } } } } } }`,
        variables: { id: customerGid },
      }),
    });
    const gqlData = await res.json();
    const profiles = gqlData.data?.customer?.companyContactProfiles ?? [];
    for (const profile of profiles) {
      for (const loc of profile.company?.locations?.nodes ?? []) {
        const id = await catalogIdFromLocationGid(prisma, loc.id);
        if (id) return id;
      }
    }
  } catch (e) {}
  return null;
}

function isLegacyId(value) { return value.includes("/") || /^\d{10,}$/.test(value); }

export async function loader({ request }) {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  let locationId = url.searchParams.get("locationId");
  let catalogId = locationId ? await catalogIdFromLocationGid(prisma, locationId) : null;

  if (!catalogId) {
    catalogId = url.searchParams.get("catalogId") || null;
    if (catalogId?.includes("/")) catalogId = catalogId.split("/").pop();
  }

  if (!catalogId) {
    const customerId = url.searchParams.get("customerId");
    const shop = url.searchParams.get("shop");
    catalogId = await catalogIdFromCustomer(prisma, customerId, shop);
  }

  if (!catalogId) {
    return new Response(JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false }), { status: 200, headers: CORS_HEADERS });
  }

  if (catalogId.includes("/")) catalogId = catalogId.split("/").pop();
  const rule = await prisma.catalogRule.findUnique({ where: { catalogId } });
  let override = null;
  if (productId) override = await prisma.productOverride.findUnique({ where: { catalogId_productId: { catalogId, productId } } });

  if (override && override.hiddenVariantIds.length > 0) {
    if (!override.hiddenVariantIds.every(isLegacyId)) {
      const titles = override.hiddenVariantIds.filter(v => !isLegacyId(v));
      return new Response(JSON.stringify({ hiddenVariantTypes: titles, hiddenVariantIds: [], hasOverride: true }), { status: 200, headers: CORS_HEADERS });
    }
  }

  return new Response(JSON.stringify({ hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [], hiddenVariantIds: [], hasOverride: !!override }), { status: 200, headers: CORS_HEADERS });
}
