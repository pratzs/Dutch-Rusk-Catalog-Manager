// What is left of the catalog rules endpoint.
//
// The variant-hiding feature is gone. Pack-size restrictions are now Shopify's
// own variant-level publishing, applied per variant per catalog, so the
// storefront no longer asks this app what to hide and there is nothing here to
// answer with. The rules pages, the clone/migrate/audit tools and the
// in-memory rules cache were all removed with it.
//
// Two things still route through here:
//
//   1. dealsOnly — whether this buyer's catalog has any BOGO deal, which
//      decides if the "Special Deals" menu item is shown. Shopify cannot
//      express that, so it stays.
//
//   2. A deliberately empty answer for the OLD storefront script. Browser
//      sessions that loaded before the variant hider was retired still ask for
//      rules, and that script fails CLOSED: an error or a missing answer made
//      it mark the card "Back Soon". So this keeps replying "nothing hidden",
//      which is now the truth, until those sessions age out. Do not delete this
//      path in a hurry -- removing it would put wrongful "Back Soon" back on
//      stocked product for anyone still holding the old page.

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

// Nothing is hidden by this app any more, so the answer is the same for every
// product and can be cached hard.
const EMPTY_RULES_HEADERS = {
  ...CORS_HEADERS,
  "Cache-Control": "public, max-age=3600",
  Pragma: "",
  Expires: "",
};

const EMPTY_RULE = { hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false };

function normalizeLocationGid(locationGid) {
  return String(locationGid).includes("/") ? locationGid : `gid://shopify/CompanyLocation/${locationGid}`;
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

/** Every price list the location can be priced from, [] when unknown. */
async function priceListsForLocation(prisma, locationGid) {
  const mapping = await prisma.locationCatalogMap.findUnique({
    where: { locationGid: normalizeLocationGid(locationGid) },
  });
  try {
    const ids = JSON.parse(mapping?.priceListIds ?? "[]");
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
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
  try {
    await prisma.locationCatalogMap.updateMany({
      where: { locationGid: gid },
      data: { priceListIds: JSON.stringify(ids) },
    });
  } catch (e) {
    console.error("[catalog-rules] could not cache location price lists:", e?.message || e);
  }
  return ids;
}

/**
 * Whether to show the "Special Deals" menu item to this buyer.
 *
 * Returns null for "don't know" -- a retail visitor, a location we have no
 * price lists for, or an unreadable deal config. The storefront leaves the menu
 * hidden in that case, which is the safe direction: a buyer who cannot get a
 * deal must never be shown the link.
 */
async function resolveDealsEligible(prisma, shop, locationId) {
  if (!shop || !locationId) return null;
  try {
    let priceLists = await priceListsForLocation(prisma, locationId);
    // The column is filled by the price sync, so it starts empty for any
    // location added since the last run. Look it up once and write it back.
    if (priceLists.length === 0) {
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

export async function loader({ request }) {
  const url = new URL(request.url);

  // Pre-warm ping from the older storefront script.
  if (url.searchParams.get("_ping")) {
    return new Response(JSON.stringify({ ok: true, t: Date.now() }), { status: 200, headers: CORS_HEADERS });
  }

  const shop = url.searchParams.get("shop");
  const locationId = url.searchParams.get("locationId");

  if (url.searchParams.get("dealsOnly")) {
    const { default: prisma } = await import("../db.server");
    const eligible = await resolveDealsEligible(prisma, shop, locationId);
    return new Response(JSON.stringify({ dealsEligible: eligible }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Cache-Control": "private, max-age=1800", Pragma: "", Expires: "" },
    });
  }

  // ── Legacy: the retired variant hider asking what to hide ─────────────────
  // Answer "nothing", in the exact shape it expects. It fails closed, so it
  // must get a valid 200 rather than a 404 or an error.
  const productIdsParam = url.searchParams.get("productIds");
  if (productIdsParam) {
    const batch = {};
    for (const raw of productIdsParam.split(",").map((s) => s.trim()).filter(Boolean)) {
      batch[raw.includes("/") ? raw.split("/").pop() : raw] = { ...EMPTY_RULE };
    }
    return new Response(
      JSON.stringify({ batch, debug: { version: "300", retired: true } }),
      { status: 200, headers: EMPTY_RULES_HEADERS }
    );
  }

  return new Response(JSON.stringify({ ...EMPTY_RULE, debug: { version: "300", retired: true } }), {
    status: 200,
    headers: EMPTY_RULES_HEADERS,
  });
}
