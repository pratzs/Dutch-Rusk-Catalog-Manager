// app/routes/api.catalog-rules.jsx

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

// Successful rule lookups are cacheable for a short window.
//
// This endpoint is hit by every product card on every storefront page view,
// and the app runs on a single small instance. Previously the storefront also
// added a `_t=<now>` cache-buster, so nothing was ever reused: a shopper
// paging through a collection re-asked for the same rules constantly, and the
// occasional slow or failed request showed "Back Soon" on stocked product.
//
// 60 seconds matches the storefront's own rule TTL, so admin changes still show
// up about as quickly as before. `private` is essential — the answer depends on
// the buyer's company location, so it must never sit in a shared/CDN cache.
const CACHEABLE_HEADERS = {
  ...CORS_HEADERS,
  "Cache-Control": "private, max-age=60",
  "Pragma": "",
  "Expires": ""
};

function normalizeLocationGid(locationGid) {
  return String(locationGid).includes("/") ? locationGid : `gid://shopify/CompanyLocation/${locationGid}`;
}

/**
 * One lookup, both answers. This endpoint is hit by every product card on every
 * page view, so it deliberately reads the mapping row once and derives both the
 * catalog id and the price list set from it rather than querying twice.
 */
async function locationMapping(prisma, locationGid, cache) {
  if (!locationGid) return { catalogId: null, priceListIds: [] };
  const gid = normalizeLocationGid(locationGid);
  const { locationFor } = await import("../lib/rules-cache.server");
  const mapping = locationFor(cache, gid) ?? (cache ? null : await prisma.locationCatalogMap.findUnique({ where: { locationGid: gid } }));
  let priceListIds = [];
  try {
    const ids = JSON.parse(mapping?.priceListIds ?? "[]");
    if (Array.isArray(ids)) priceListIds = ids;
  } catch {
    priceListIds = [];
  }
  return { catalogId: mapping?.catalogId ?? null, priceListIds };
}

async function catalogIdFromLocationGid(prisma, locationGid, cache) {
  return (await locationMapping(prisma, locationGid, cache)).catalogId;
}

/** Runs an admin GraphQL query with the shop's offline token. */
function adminGql(prisma, shop) {
  return async (query) => {
    const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
    if (!session?.accessToken) throw new Error("no offline session");
    const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  };
}

/**
 * Whether to show the "Special Deals" menu item to this buyer.
 *
 * Returns null for "don't know" -- a retail visitor, a location we have no
 * price lists for, or an unreadable deal config. The storefront leaves the menu
 * hidden in that case, which is the safe direction: a buyer who cannot get a
 * deal must never be shown the link, and a General buyer briefly missing it is
 * the lesser problem.
 */
async function resolveDealsEligible(prisma, shop, locationId, buyerPriceLists) {
  if (!shop) return null;
  try {
    let priceLists = Array.isArray(buyerPriceLists) ? buyerPriceLists : [];

    // The priceListIds column is filled by the price sync, so it starts empty
    // on existing rows and stays empty for any location added since the last
    // run. Rather than depend on that ordering, look the location's catalogs up
    // once and write the answer back -- so the first buyer from a location pays
    // one extra query and nobody after them does.
    if (priceLists.length === 0 && locationId) {
      priceLists = await backfillLocationPriceLists(prisma, shop, locationId);
    }
    if (priceLists.length === 0) return null;

    const { getDealScope, isDealEligible } = await import("../lib/deals.server");
    const scope = await getDealScope(shop, adminGql(prisma, shop));
    return isDealEligible(scope, priceLists);
  } catch (e) {
    console.error("[catalog-rules] deals eligibility failed:", e?.message || e);
    return null;
  }
}

/** Ask Shopify which price lists a location has, and remember the answer. */
async function backfillLocationPriceLists(prisma, shop, locationId) {
  const gid = normalizeLocationGid(locationId);
  const data = await adminGql(prisma, shop)(`{
    companyLocation(id: "${gid}") {
      catalogs(first: 20) { nodes { ... on CompanyLocationCatalog { priceList { id } } } }
    }
  }`);
  const ids = [];
  for (const node of data?.companyLocation?.catalogs?.nodes ?? []) {
    const id = node?.priceList?.id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return [];

  // Only update an existing row. Creating one would invent a catalogId the
  // variant-hiding rules would then key off, and that is not this function's
  // job -- the price sync owns that mapping.
  try {
    await prisma.locationCatalogMap.updateMany({
      where: { locationGid: gid },
      data: { priceListIds: JSON.stringify(ids) },
    });
    const { noteLocationPriceLists } = await import("../lib/rules-cache.server");
    noteLocationPriceLists(gid, ids);
  } catch (e) {
    console.error("[catalog-rules] could not cache location price lists:", e?.message || e);
  }
  return ids;
}

async function resolveB2BContext(prisma, customerId, shop, cache) {
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
    if (gqlData.errors) {
      console.error("[catalog-rules] GraphQL error in resolveB2BContext:", JSON.stringify(gqlData.errors));
      throw new Error("GraphQL error resolving B2B context");
    }
    const profiles = gqlData.data?.customer?.companyContactProfiles ?? [];
    for (const profile of profiles) {
      for (const loc of profile.company?.locations?.nodes ?? []) {
        const id = await catalogIdFromLocationGid(prisma, loc.id, cache);
        if (id) return id;
      }
    }
  } catch (e) {
    console.error("[catalog-rules] resolveB2BContext failed:", e.message || e);
    throw e;
  }
  return null;
}

function isLegacyId(value) { return String(value).includes("/") || /^\d{10,}$/.test(String(value)); }

async function findRule(prisma, catalogId, cache) {
  if (!catalogId) return null;
  if (cache) {
    const { ruleFor } = await import("../lib/rules-cache.server");
    const cached = ruleFor(cache, catalogId);
    // undefined means the cache won't choose between duplicate rows for this
    // catalog, so fall through to the original query and keep behaviour identical.
    if (cached !== undefined) return cached;
  }
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

async function findOverride(prisma, catalogId, productId, cache) {
  if (!catalogId || !productId) return null;
  if (cache) {
    const { overrideFor } = await import("../lib/rules-cache.server");
    return overrideFor(cache, catalogId, productId);
  }
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
  const url = new URL(request.url);

  // ── Fast pre-warm path — no DB, just keeps Render alive ──────────────────
  // The liquid snippet fires this immediately on B2B page loads so the instance
  // is already warm by the time the real catalog-rules call arrives.
  if (url.searchParams.get("_ping")) {
    // `&cache=1` reports the in-memory rules cache, so its health can be
    // checked without waiting for a shopper to hit a collection page.
    let rulesCache;
    if (url.searchParams.get("cache")) {
      const { rulesCacheStatus } = await import("../lib/rules-cache.server");
      rulesCache = rulesCacheStatus();
    }
    return new Response(JSON.stringify({ ok: true, t: Date.now(), ...(rulesCache ? { rulesCache } : {}) }), { status: 200, headers: CORS_HEADERS });
  }

  const { default: prisma } = await import("../db.server");
  const shop       = url.searchParams.get("shop");

  // Catalog rules, product overrides and location mappings all come from
  // memory. The database sits in Oregon while this runs in Singapore, so each
  // query it saves is a ~150-200ms trans-Pacific round trip, and this endpoint
  // is hit by every product card on every page view. A null cache means the
  // data isn't usable yet and every lookup below falls back to the database on
  // its own, so behaviour is identical either way.
  const { getRulesCache } = await import("../lib/rules-cache.server");
  const cache = await getRulesCache(prisma);

  // ── Deals-only path — used by the "Special Deals" menu gate ───────────────
  // Runs on every page, including ones with no product cards, so it skips all
  // the variant-rule work and answers from one mapping row plus the cached deal
  // config. The storefront caches the answer for half an hour, so this is a
  // handful of requests per buyer per day, not one per page view.
  if (url.searchParams.get("dealsOnly")) {
    const locId = url.searchParams.get("locationId");
    const { priceListIds } = locId ? await locationMapping(prisma, locId, cache) : { priceListIds: [] };
    const eligible = await resolveDealsEligible(prisma, shop, locId, priceListIds);
    return new Response(
      JSON.stringify({ dealsEligible: eligible }),
      { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "private, max-age=1800", "Pragma": "", "Expires": "" } }
    );
  }

  const customerId = url.searchParams.get("customerId");
  const productIdsParam = url.searchParams.get("productIds"); // batch: comma-separated
  const productId       = url.searchParams.get("productId");  // single

  // ── Resolve catalog ID (same for both single and batch) ───────────────────
  let locationId = url.searchParams.get("locationId");
  const mapping  = locationId ? await locationMapping(prisma, locationId, cache) : { catalogId: null, priceListIds: [] };
  let catalogId  = mapping.catalogId;
  const buyerPriceLists = mapping.priceListIds;

  // resolveB2BContext makes a live Shopify Admin GraphQL call — only fall back
  // to it when locationId didn't already resolve the catalog. Previously this
  // ran unconditionally on every request (locationId is normally always sent
  // too), so any transient slowness/rate-limiting on that one extra API call
  // 503'd the whole batch and sent every product on the page to "Back Soon",
  // even though the locationId path had already succeeded.
  if (customerId && !catalogId) {
    try {
      const b2bContext = await resolveB2BContext(prisma, customerId, shop, cache);
      if (b2bContext) catalogId = b2bContext;
    } catch (e) {
      console.error("[catalog-rules] B2B context resolution failed, returning 503:", e.message || e);
      return new Response(
        JSON.stringify({ error: "upstream_error", message: "Unable to resolve catalog rules" }),
        { status: 503, headers: CORS_HEADERS }
      );
    }
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
  const rule = await findRule(prisma, catalogId, cache);
  const cleanCatalogId = String(catalogId).includes("/") ? catalogId.split("/").pop() : catalogId;

  // ══ BATCH MODE — productIds=id1,id2,id3,... ═══════════════════════════════
  if (productIdsParam) {
    const rawIds   = productIdsParam.split(",").map(s => s.trim()).filter(Boolean);
    const cleanIds = rawIds.map(id => String(id).includes("/") ? id.split("/").pop() : id);

    // Overrides for this batch. From memory when the cache is up, otherwise one
    // query for the whole batch as before.
    const overrideMap = {};
    if (cache) {
      const { overrideFor } = await import("../lib/rules-cache.server");
      for (const cleanId of cleanIds) {
        const ov = overrideFor(cache, cleanCatalogId, cleanId);
        if (ov) overrideMap[cleanId] = ov;
      }
    } else {
      const allOverrides = cleanIds.length > 0
        ? await prisma.productOverride.findMany({
            where: {
              catalogId: cleanCatalogId,
              productId: { in: [...cleanIds, ...cleanIds.map(id => `gid://shopify/Product/${id}`)] }
            }
          })
        : [];
      for (const ov of allOverrides) {
        const cleanProd = String(ov.productId).includes("/") ? ov.productId.split("/").pop() : ov.productId;
        overrideMap[cleanProd] = ov;
      }
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
        dealsEligible: await resolveDealsEligible(prisma, shop, locationId, buyerPriceLists),
        debug: { version: "248", resolvedCatalogId: catalogId, ruleFound: !!rule, productCount: cleanIds.length }
      }),
      { status: 200, headers: CACHEABLE_HEADERS }
    );
  }

  // ══ SINGLE MODE — productId=xxx (unchanged behaviour) ═════════════════════
  const override = productId ? await findOverride(prisma, catalogId, productId, cache) : null;
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
    { status: 200, headers: CACHEABLE_HEADERS }
  );
}
