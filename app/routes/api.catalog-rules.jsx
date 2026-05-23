// app/routes/api.catalog-rules.jsx

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "X-CVH-Debug": "true"
};

async function catalogIdFromLocationGid(prisma, locationGid) {
  if (!locationGid) return null;
  const normalized = String(locationGid).includes("/") ? locationGid : `gid://shopify/CompanyLocation/${locationGid}`;
  const mapping = await prisma.locationCatalogMap.findUnique({ where: { locationGid: normalized } });
  console.log(`[CVH-API] DB Lookup | locationGid: ${normalized} | Resolved Catalog: ${mapping?.catalogId || 'NONE'}`);
  return mapping?.catalogId ?? null;
}

async function catalogIdFromCustomer(prisma, customerId, shop) {
  if (!customerId || !shop) return null;
  const customerGid = String(customerId).includes("/") ? customerId : `gid://shopify/Customer/${customerId}`;
  
  console.log(`[CVH-API] Resolving catalog via Customer: ${customerGid}`);

  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) {
    console.error(`[CVH-API] Auth failure: No offline session`);
    return null;
  }

  try {
    const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({
        query: `query($id: ID!) { customer(id: $id) { companyContactProfiles { company { id locations(first: 50) { nodes { id } } } } } }`,
        variables: { id: customerGid },
      }),
    });
    const gqlData = await res.json();
    if (gqlData.errors) {
        console.error(`[CVH-API] Shopify Error:`, JSON.stringify(gqlData.errors));
        return null;
    }

    const profiles = gqlData.data?.customer?.companyContactProfiles ?? [];
    for (const profile of profiles) {
      for (const loc of profile.company?.locations?.nodes ?? []) {
        const id = await catalogIdFromLocationGid(prisma, loc.id);
        if (id) return id;
      }
    }
  } catch (e) {
    console.error(`[CVH-API] Resolution Exception:`, e);
  }
  return null;
}

function isLegacyId(value) { return String(value).includes("/") || /^\d{10,}$/.test(String(value)); }

async function findRule(prisma, catalogId) {
    if (!catalogId) return null;
    const cleanId = String(catalogId).includes("/") ? catalogId.split("/").pop() : catalogId;
    
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
    console.log(`[CVH-API] Rule Search | catalogId: ${catalogId} | Result: ${rule ? 'FOUND' : 'MISSING'}`);
    return rule;
}

async function findOverride(prisma, catalogId, productId) {
    if (!catalogId || !productId) return null;
    const cleanCat = String(catalogId).includes("/") ? catalogId.split("/").pop() : catalogId;
    const cleanProd = String(productId).includes("/") ? productId.split("/").pop() : productId;
    const fullProd = `gid://shopify/Product/${cleanProd}`;

    const override = await prisma.productOverride.findFirst({
        where: {
            catalogId: cleanCat,
            OR: [
                { productId: cleanProd },
                { productId: fullProd }
            ]
        }
    });
    console.log(`[CVH-API] Override Search | catalogId: ${cleanCat} | productId: ${cleanProd} | Result: ${override ? 'FOUND' : 'MISSING'}`);
    return override;
}

export async function loader({ request }) {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId");

  let locationId = url.searchParams.get("locationId");
  let strategy = "locationId";
  let catalogId = locationId ? await catalogIdFromLocationGid(prisma, locationId) : null;

  if (!catalogId) {
    const catalogIdParam = url.searchParams.get("catalogId");
    if (catalogIdParam) {
        catalogId = catalogIdParam;
        strategy = "catalogIdParam";
    }
  }

  if (!catalogId && customerId) {
    catalogId = await catalogIdFromCustomer(prisma, customerId, shop);
    strategy = "customerId";
  }

  if (!catalogId) {
    console.warn(`[CVH-API] Resolution FAILED for location: ${locationId}, customer: ${customerId}`);
    return new Response(JSON.stringify({ 
        hiddenVariantTypes: [], 
        hiddenVariantIds: [], 
        hasOverride: false,
        debug: { strategy: "failed", locationId, customerId } 
    }), { status: 200, headers: CORS_HEADERS });
  }

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

  const response = { 
    hiddenVariantTypes: Array.from(hiddenTypes), 
    hiddenVariantIds: Array.from(hiddenIds), 
    hasOverride: !!override,
    debug: {
        strategy,
        resolvedCatalogId: catalogId,
        ruleFound: !!rule,
        ruleName: rule?.catalogName,
        overrideFound: !!override,
        productId,
        locationId
    }
  };

  return new Response(JSON.stringify(response), { status: 200, headers: CORS_HEADERS });
}
