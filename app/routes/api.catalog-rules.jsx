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

  // First pass: try existing LocationCatalogMap entries.
  for (const profile of profiles) {
    for (const loc of profile.company?.locations?.nodes ?? []) {
      const id = await catalogIdFromLocationGid(loc.id);
      if (id) { console.log("[CVH-API] Resolved catalogId:", id); return id; }
    }
  }

  // No match — map is stale/missing. Re-sync catalog→location data then retry.
  console.log("[CVH-API] LocationCatalogMap miss — syncing catalog locations for shop:", shop);
  try {
    const syncRes = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query: `query { catalogs(first: 250) { nodes { id ... on CompanyLocationCatalog { companyLocations(first: 50) { nodes { id } } } } } }` }),
    });
    const syncData = await syncRes.json();
    if (!syncData.errors) {
      const upserts = [];
      for (const cat of syncData.data.catalogs.nodes) {
        const cid = cat.id.split("/").pop();
        for (const loc of cat.companyLocations?.nodes ?? []) {
          upserts.push(prisma.locationCatalogMap.upsert({
            where: { locationGid: loc.id }, update: { catalogId: cid }, create: { locationGid: loc.id, catalogId: cid },
          }));
        }
      }
      if (upserts.length > 0) await Promise.all(upserts);
      console.log("[CVH-API] Sync wrote", upserts.length, "location mappings");
    }
  } catch (syncErr) {
    console.error("[CVH-API] Sync error:", syncErr);
  }

  // Retry lookup with freshly synced data.
  for (const profile of profiles) {
    for (const loc of profile.company?.locations?.nodes ?? []) {
      const id = await catalogIdFromLocationGid(loc.id);
      if (id) { console.log("[CVH-API] Resolved (after sync) catalogId:", id); return id; }
    }
  }
  console.error("[CVH-API] Still no match after sync for customer:", customerGid);
  return null;
}

// Returns true if a stored override value looks like a legacy GID or numeric variant ID
// (saved before the title-based override system was introduced).
function isLegacyId(value) {
  return value.includes("/") || /^\d{10,}$/.test(value);
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
    console.warn("[CVH-API] Could not resolve catalog for request, returning empty rules");
    return new Response(
      JSON.stringify({
        hiddenVariantTypes: [],
        hiddenVariantIds: [],
        hasOverride: false,
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  }

  if (catalogId.includes("/")) catalogId = catalogId.split("/").pop();

  const rule = await prisma.catalogRule.findUnique({ where: { catalogId } });

  let override = null;
  if (productId) {
    override = await prisma.productOverride.findUnique({
      where: { catalogId_productId: { catalogId, productId } },
    });
  }

  // ── Product-level override logic ──────────────────────────────────────────
  // Overrides now store variant TITLES (e.g. "Outer", "Shipper (6 Outer)") so
  // the storefront can match by name using startsWith.  Legacy overrides that
  // contain GIDs or numeric IDs are treated the same as no override — blanket
  // rules apply.
  if (override && override.hiddenVariantIds.length > 0) {
    const allLegacy = override.hiddenVariantIds.every(isLegacyId);

    if (!allLegacy) {
      // New-style: stored values are variant titles.  They become the complete
      // hiddenVariantTypes for this product — blanket rules are intentionally
      // skipped, which allows showing a normally-blocked type (e.g. Shipper)
      // for a specific product.
      const titles = override.hiddenVariantIds.filter(v => !isLegacyId(v));
      return new Response(
        JSON.stringify({ hiddenVariantTypes: titles, hiddenVariantIds: [], hasOverride: true }),
        { status: 200, headers: CORS_HEADERS }
      );
    }
    // Legacy GID-based override → fall through and apply blanket rules.
  }

  // No override, empty override, or legacy-only override — apply blanket rules.
  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds: [],
      hasOverride: !!override,
    }),
    { status: 200, headers: CORS_HEADERS }
  );
}
