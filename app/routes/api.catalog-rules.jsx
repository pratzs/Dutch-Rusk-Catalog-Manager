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
        query: `query($id: ID!) { customer(id: $id) { companyContactProfiles { company { id name locations(first: 50) { nodes { id name } } } } } }`,
        variables: { id: customerGid },
      }),
    });
    const gqlData = await res.json();
    if (gqlData.errors) return null;

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

async function findRule(prisma, catalogId) {
    if (!catalogId) return null;
    const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
    return await prisma.catalogRule.findFirst({
        where: {
            OR: [
                { catalogId: cleanId },
                { catalogId: `gid://shopify/MarketCatalog/${cleanId}` },
                { catalogId: `gid://shopify/CompanyLocationCatalog/${cleanId}` },
                { catalogId: `gid://shopify/AppCatalog/${cleanId}` }
            ]
        }
    });
}

async function findOverride(prisma, catalogId, productId) {
    if (!catalogId || !productId) return null;
    const cleanCat = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
    const cleanProd = productId.includes("/") ? productId.split("/").pop() : productId;
    const fullProd = `gid://shopify/Product/${cleanProd}`;

    return await prisma.productOverride.findFirst({
        where: {
            catalogId: cleanCat,
            OR: [
                { productId: cleanProd },
                { productId: fullProd }
            ]
        }
    });
}

export async function loader({ request }) {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const shop = url.searchParams.get("shop");

  let locationId = url.searchParams.get("locationId");
  let catalogId = locationId ? await catalogIdFromLocationGid(prisma, locationId) : null;

  if (!catalogId) {
    const catalogIdParam = url.searchParams.get("catalogId");
    if (catalogIdParam) catalogId = catalogIdParam;
  }

  if (!catalogId) {
    const customerId = url.searchParams.get("customerId");
    catalogId = await catalogIdFromCustomer(prisma, customerId, shop);
  }

  if (!catalogId) {
    return new Response(JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false }), { status: 200, headers: CORS_HEADERS });
  }

  // Resolve blanket rules and overrides in parallel
  const [rule, override] = await Promise.all([
      findRule(prisma, catalogId),
      productId ? findOverride(prisma, catalogId, productId) : Promise.resolve(null)
  ]);

  const hiddenTypes = new Set(rule?.hiddenVariantTypes ?? []);
  const hiddenIds = new Set(rule?.hiddenVariantIds ?? []);

  if (override && override.hiddenVariantIds.length > 0) {
      for (const val of override.hiddenVariantIds) {
          if (isLegacyId(val)) {
              hiddenIds.add(val);
          } else {
              hiddenTypes.add(val);
          }
      }
  }

  return new Response(
    JSON.stringify({ 
      hiddenVariantTypes: Array.from(hiddenTypes), 
      hiddenVariantIds: Array.from(hiddenIds), 
      hasOverride: !!override 
    }), 
    { status: 200, headers: CORS_HEADERS }
  );
}
