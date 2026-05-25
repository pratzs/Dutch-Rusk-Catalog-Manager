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

// ── Shared rule-merge logic ───────────────────────────────────────────────────
// Merges a catalog blanket rule + a product-level override into the final set
// of { hiddenTypes, hiddenIds } to send to the storefront.
function computeProductRules(rule, override) {
  const hiddenTypes = new Set();
  const hiddenIds   = new Set();

  if (rule) {
    (rule.hiddenVariantTypes ?? []).filter(v => v && String(v).trim()).forEach(v => hiddenTypes.add(v));
    (rule.hiddenVariantIds   ?? []).filter(v => v && String(v).trim()).forEach(v => hiddenIds.add(v));
  }

  let overrideActive = false;

  if (override) {
    const vals = (override.hiddenVariantIds ?? []).filter(v => v && String(v).trim());
    overrideActive = true;

    if (vals.includes("__SHOW_ALL__")) {
      hiddenTypes.clear();
      hiddenIds.clear();
    } else if (vals.length > 0) {
      const allLegacyIds = vals.every(v => isLegacyId(v));
      if (allLegacyIds) {
        for (const val of vals) hiddenIds.add(val);
        // hiddenTypes unchanged — blanket still applies
      } else {
        hiddenTypes.clear();
        hiddenIds.clear();
        for (const val of vals) {
          if (isLegacyId(val)) {
            hiddenIds.add(val);
          } else {
            const cleanVal = String(val).trim();
            hiddenTypes.add(cleanVal);
            if (cleanVal.toLowerCase().startsWith("shipper")) hiddenTypes.add("shipper");
            if (cleanVal.toLowerCase().startsWith("bag"))     hiddenTypes.add("bag");
          }
        }
      }
    }
    // If vals is empty: override row exists but no specific values → retain blanket unchanged
  }

  return { hiddenTypes, hiddenIds, overrideActive };
}

export async function loader({ request }) {
  const { default: prisma } = await import("../db.server");
  const url        = new URL(request.url);
  const shop       = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId");
  const productIdsParam = url.searchParams.get("productIds"); // batch: comma-separated
  const productId       = url.searchParams.get("productId");  // single

  // ── Resolve catalog ID (same for both single and batch) ───────────────────
  let locationId = url.searchParams.get("locationId");
  let catalogId  = locationId ? await catalogIdFromLocationGid(prisma, locationId) : null;

  if (customerId) {
    const b2bContext = await resolveB2BContext(prisma, customerId, shop);
    if (b2bContext) catalogId = b2bContext;
  }
  if (!catalogId) {
    const pId = url.searchParams.get("catalogId");
    if (pId) catalogId = pId;
  }

  if (!catalogId) {
    // No catalog found — return empty rules (retail / unauthenticated visitor)
    if (productIdsParam) {
      return new Response(JSON.stringify({ batch: {}, debug: { version: "247", resolvedCatalogId: null } }), { status: 200, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false }), { status: 200, headers: CORS_HEADERS });
  }

  // ── Fetch the blanket rule (shared by both modes) ─────────────────────────
  const rule = await findRule(prisma, catalogId);
  const cleanCatalogId = String(catalogId).includes("/") ? catalogId.split("/").pop() : catalogId;

  // ══ BATCH MODE — productIds=id1,id2,id3,... ═══════════════════════════════
  if (productIdsParam) {
    const rawIds   = productIdsParam.split(",").map(s => s.trim()).filter(Boolean);
    const cleanIds = rawIds.map(id => String(id).includes("/") ? id.split("/").pop() : id);

    // One DB query for ALL overrides in this batch
    const allOverrides = cleanIds.length > 0
      ? await prisma.productOverride.findMany({
          where: {
            catalogId: cleanCatalogId,
            productId: { in: [...cleanIds, ...cleanIds.map(id => `gid://shopify/Product/${id}`)] }
          }
        })
      : [];

    // Build override lookup: cleanProductId → override row
    const overrideMap = {};
    for (const ov of allOverrides) {
      const cleanProd = String(ov.productId).includes("/") ? ov.productId.split("/").pop() : ov.productId;
      overrideMap[cleanProd] = ov;
    }

    // Compute merged rules for each product
    const batch = {};
    for (const cleanId of cleanIds) {
      const override = overrideMap[cleanId] ?? null;
      const { hiddenTypes, hiddenIds, overrideActive } = computeProductRules(rule, override);
      batch[cleanId] = {
        hiddenVariantTypes: Array.from(hiddenTypes),
        hiddenVariantIds:   Array.from(hiddenIds),
        hasOverride:        overrideActive,
      };
    }

    return new Response(
      JSON.stringify({
        batch,
        debug: { version: "247", resolvedCatalogId: catalogId, ruleFound: !!rule, productCount: cleanIds.length }
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  }

  // ══ SINGLE MODE — productId=xxx (unchanged behaviour) ═════════════════════
  const override = productId ? await findOverride(prisma, catalogId, productId) : null;
  const { hiddenTypes, hiddenIds, overrideActive } = computeProductRules(rule, override);

  return new Response(
    JSON.stringify({
      hiddenVariantTypes: Array.from(hiddenTypes),
      hiddenVariantIds:   Array.from(hiddenIds),
      hasOverride:        overrideActive,
      debug: {
        version: "247",
        resolvedCatalogId: catalogId,
        ruleFound:    !!rule,
        overrideFound: !!override,
        overrideActive,
        allLegacyIds: override
          ? (override.hiddenVariantIds ?? []).filter(v => v && String(v).trim()).every(v => isLegacyId(v))
          : null,
      }
    }),
    { status: 200, headers: CORS_HEADERS }
  );
}
