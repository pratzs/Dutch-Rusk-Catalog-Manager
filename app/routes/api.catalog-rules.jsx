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
  
  console.log(`[CVH-API] Resolving catalog for Customer: ${customerGid} on Shop: ${shop}`);

  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) {
    console.error(`[CVH-API] No offline session found for ${shop}`);
    return null;
  }

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
    
    if (gqlData.errors) {
        console.error(`[CVH-API] Shopify API Error:`, JSON.stringify(gqlData.errors));
        return null;
    }

    const profiles = gqlData.data?.customer?.companyContactProfiles ?? [];
    console.log(`[CVH-API] Found ${profiles.length} company profile(s) for customer`);

    for (const profile of profiles) {
      const locations = profile.company?.locations?.nodes ?? [];
      console.log(`[CVH-API] Company ${profile.company?.id} (${profile.company?.name}) has ${locations.length} location(s)`);
      for (const loc of locations) {
        const id = await catalogIdFromLocationGid(prisma, loc.id);
        if (id) {
            console.log(`[CVH-API] SUCCESS: Found catalog ${id} for location ${loc.id} (${loc.name})`);
            return id;
        }
      }
    }
  } catch (e) {
    console.error(`[CVH-API] Exception in resolution:`, e);
  }
  
  console.warn(`[CVH-API] No B2B catalog found for customer ${customerGid}`);
  return null;
}

function isLegacyId(value) { return value.includes("/") || /^\d{10,}$/.test(value); }

async function findRule(prisma, catalogId) {
    if (!catalogId) return null;
    const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
    
    // Try multiple ID formats to ensure we find the rule
    const rule = await prisma.catalogRule.findFirst({
        where: {
            OR: [
                { catalogId: cleanId },
                { catalogId: `gid://shopify/MarketCatalog/${cleanId}` },
                { catalogId: `gid://shopify/CompanyLocationCatalog/${cleanId}` },
                { catalogId: `gid://shopify/AppCatalog/${cleanId}` }
            ]
        }
    });
    return rule;
}

export async function loader({ request }) {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const shop = url.searchParams.get("shop");

  let locationId = url.searchParams.get("locationId");
  let catalogId = locationId ? await catalogIdFromLocationGid(prisma, locationId) : null;

  console.log(`[CVH-API] Request | locationId: ${locationId} | catalogId: ${catalogId} | productId: ${productId}`);

  if (!catalogId) {
    catalogId = url.searchParams.get("catalogId") || null;
    if (catalogId) console.log(`[CVH-API] Resolved from catalogId param: ${catalogId}`);
  }

  if (!catalogId) {
    const customerId = url.searchParams.get("customerId");
    catalogId = await catalogIdFromCustomer(prisma, customerId, shop);
    if (catalogId) console.log(`[CVH-API] Resolved from customerId: ${catalogId}`);
  }

  if (!catalogId) {
    console.warn(`[CVH-API] Failed to resolve catalog for query: ${url.search}`);
    return new Response(JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false }), { status: 200, headers: CORS_HEADERS });
  }

  const rule = await findRule(prisma, catalogId);
  console.log(`[CVH-API] Rule for catalog ${catalogId}:`, rule ? `Found (${rule.catalogName})` : "NOT Found");

  let override = null;
  const cleanCatalogId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
  if (productId) {
      const cleanProductId = productId.includes("/") ? productId.split("/").pop() : productId;
      override = await prisma.productOverride.findUnique({ 
          where: { catalogId_productId: { catalogId: cleanCatalogId, productId: cleanProductId } } 
      });
  }

  const hiddenTypes = new Set(rule?.hiddenVariantTypes ?? []);
  const hiddenIds = new Set(rule?.hiddenVariantIds ?? []);

  if (override) {
    if (override.hiddenVariantIds.length > 0) {
      for (const val of override.hiddenVariantIds) {
        if (isLegacyId(val)) {
          hiddenIds.add(val);
        } else {
          hiddenTypes.add(val);
        }
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
