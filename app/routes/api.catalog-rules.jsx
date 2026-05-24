// app/routes/api.catalog-rules.jsx

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

async function catalogIdFromLocationGid(prisma, locationGid) {
  if (!locationGid) return null;
  const normalized = String(locationGid).includes("/") ? locationGid : `gid://shopify/CompanyLocation/${locationGid}`;
  const mapping = await prisma.locationCatalogMap.findUnique({ where: { locationGid: normalized } });
  return mapping?.catalogId ?? null;
}

async function resolveB2BContext(prisma, customerId, shop) {
  if (!customerId || !shop) return null;
  const customerGid = String(customerId).includes("/") ? customerId : `gid://shopify/Customer/${customerId}`;
  
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) return null;

  try {
    const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({
        query: `query($id: ID!) { 
            customer(id: $id) { 
                firstName lastName email
                companyContactProfiles { 
                    company { 
                        id name 
                        locations(first: 50) { nodes { id name } } 
                    } 
                } 
            } 
        }`,
        variables: { id: customerGid },
      }),
    });
    const gqlData = await res.json();
    if (gqlData.errors) return null;

    const customer = gqlData.data?.customer;
    const profiles = customer?.companyContactProfiles ?? [];
    
    let resolvedCatalogId = null;
    for (const profile of profiles) {
      for (const loc of profile.company?.locations?.nodes ?? []) {
        const id = await catalogIdFromLocationGid(prisma, loc.id);
        if (!resolvedCatalogId && id) resolvedCatalogId = id;
      }
    }
    
    return { resolvedCatalogId };
  } catch (e) {
    return null;
  }
}

function isLegacyId(value) { return String(value).includes("/") || /^\d{10,}$/.test(String(value)); }

async function findRule(prisma, catalogId) {
    if (!catalogId) return null;
    const cleanId = String(catalogId).includes("/") ? catalogId.split("/").pop() : catalogId;
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
    const cleanCat = String(catalogId).includes("/") ? catalogId.split("/").pop() : catalogId;
    const cleanProd = String(productId).includes("/") ? productId.split("/").pop() : productId;
    const fullProd = `gid://shopify/Product/${cleanProd}`;

    return await prisma.productOverride.findFirst({
        where: {
            catalogId: cleanCat,
            OR: [ { productId: cleanProd }, { productId: fullProd } ]
        }
    });
}

export async function loader({ request }) {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId");

  let locationId = url.searchParams.get("locationId");
  let catalogId = locationId ? await catalogIdFromLocationGid(prisma, locationId) : null;

  if (customerId) {
      const b2bContext = await resolveB2BContext(prisma, customerId, shop);
      if (b2bContext?.resolvedCatalogId) catalogId = b2bContext.resolvedCatalogId;
  }

  if (!catalogId) {
    const catalogIdParam = url.searchParams.get("catalogId");
    if (catalogIdParam) catalogId = catalogIdParam;
  }

  if (!catalogId) {
    return new Response(JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false }), { status: 200, headers: CORS_HEADERS });
  }

  const [rule, override] = await Promise.all([
      findRule(prisma, catalogId),
      productId ? findOverride(prisma, catalogId, productId) : Promise.resolve(null)
  ]);

  let hiddenTypes = [];
  let hiddenIds = [];

  // Start with Blanket Rules as the baseline.
  if (rule) {
      hiddenTypes = (rule.hiddenVariantTypes ?? []).filter(v => v && String(v).trim());
      hiddenIds = (rule.hiddenVariantIds ?? []).filter(v => v && String(v).trim());
  }

  let overrideActive = false;

  // ── RULE PRECEDENCE ──────────────────────────────────────────────────────
  // We ONLY treat the override as a "Replacement" if it's a "Fresh" record 
  // (stored variant titles) or a sentinel.
  // Legacy overrides (storing GIDs) are ignored to prevent accidentally
  // breaking the blanket rules (e.g. for Beacon Frizzers).
  if (override) {
      const vals = (override.hiddenVariantIds ?? []).filter(v => v && String(v).trim());
      
      const containsLegacyIds = vals.some(v => isLegacyId(v));
      const isShowAll = vals.includes("__SHOW_ALL__");

      if (isShowAll) {
          // EXPLICIT CHOICE: Show everything for this product
          hiddenTypes = [];
          hiddenIds = [];
          overrideActive = true;
      } else if (vals.length > 0 && !containsLegacyIds) {
          // FRESH OVERRIDE: Replace blanket rules with these specific titles
          hiddenTypes = vals;
          hiddenIds = []; // reset GIDs as we use titles now
          overrideActive = true;
      }
  }

  return new Response(
    JSON.stringify({ 
      hiddenVariantTypes: hiddenTypes, 
      hiddenVariantIds: hiddenIds, 
      hasOverride: overrideActive,
      debug: { version: "222", resolvedCatalogId: catalogId, ruleFound: !!rule, overrideFound: !!override, overrideActive }
    }), 
    { status: 200, headers: CORS_HEADERS }
  );
}
