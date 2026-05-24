// app/routes/api.catalog-rules.jsx

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
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
        query: `query($id: ID!) { customer(id: $id) { companyContactProfiles { company { locations(first: 50) { nodes { id } } } } } }`,
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
        where: { catalogId: cleanCat, OR: [ { productId: cleanProd }, { productId: fullProd } ] }
    });
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

  if (customerId) {
      const b2bContext = await resolveB2BContext(prisma, customerId, shop);
      if (b2bContext) { catalogId = b2bContext; strategy = "customerId"; }
  }
  if (!catalogId) {
    const pId = url.searchParams.get("catalogId");
    if (pId) { catalogId = pId; strategy = "catalogIdParam"; }
  }

  if (!catalogId) {
    return new Response(JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false }), { status: 200, headers: CORS_HEADERS });
  }

  const [rule, override] = await Promise.all([
      findRule(prisma, catalogId),
      productId ? findOverride(prisma, catalogId, productId) : Promise.resolve(null)
  ]);

  const hiddenTypes = new Set();
  const hiddenIds = new Set();

  if (rule) {
      (rule.hiddenVariantTypes ?? []).filter(v => v && String(v).trim()).forEach(v => hiddenTypes.add(v));
      (rule.hiddenVariantIds ?? []).filter(v => v && String(v).trim()).forEach(v => hiddenIds.add(v));
  }

  let overrideActive = false;

  // ── COHERENT OVERRIDE PRECEDENCE WITH RED BADGE FALLBACK ─────────────────
  if (override) {
      const vals = (override.hiddenVariantIds ?? []).filter(v => v && String(v).trim());
      overrideActive = true;

      if (vals.includes("__SHOW_ALL__")) {
          // Explicitly show everything for this product (e.g. Twix gets Shipper + Outer both)
          hiddenTypes.clear();
          hiddenIds.clear();
      } else if (vals.length > 0) {
          const allLegacyIds = vals.every(v => isLegacyId(v));

          if (allLegacyIds) {
              // Override contains only numeric/GID variant IDs — ADD them to existing blanket
              // type rules rather than replacing them. This way:
              //   • Collection cards use hiddenTypes ("Shipper") for text-based matching
              //   • Product page uses both types + IDs for precise radio-input matching
              for (const val of vals) {
                  hiddenIds.add(val);
              }
              // hiddenTypes intentionally left unchanged — blanket rules still apply
          } else {
              // Override contains explicit type-name strings → REPLACE blanket rules entirely
              hiddenTypes.clear();
              hiddenIds.clear();
              for (const val of vals) {
                  if (isLegacyId(val)) {
                      hiddenIds.add(val);
                  } else {
                      const cleanVal = String(val).trim();
                      hiddenTypes.add(cleanVal);
                      if (cleanVal.toLowerCase().includes('shipper')) hiddenTypes.add('shipper');
                      if (cleanVal.toLowerCase().includes('bag')) hiddenTypes.add('bag');
                  }
              }
          }
      }
      // If vals is empty: override row exists but no specific values → retain blanket rules unchanged
  }

  return new Response(
    JSON.stringify({ 
      hiddenVariantTypes: Array.from(hiddenTypes), 
      hiddenVariantIds: Array.from(hiddenIds), 
      hasOverride: overrideActive,
      debug: { version: "241", resolvedCatalogId: catalogId, ruleFound: !!rule, overrideFound: !!override, overrideActive, allLegacyIds: override ? (override.hiddenVariantIds ?? []).filter(v => v && String(v).trim()).every(v => isLegacyId(v)) : null }
    }), 
    { status: 200, headers: CORS_HEADERS }
  );
}
