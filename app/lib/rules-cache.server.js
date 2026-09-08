// In-process cache for the catalog rules the storefront asks for on every page.
//
// WHY THIS EXISTS
// The app runs in Singapore and its Postgres is in Oregon, so every query is a
// trans-Pacific round trip of roughly 150-200ms. /api/catalog-rules made three
// of them in sequence, which is why it averaged 1.2 seconds and tailed out past
// 8. It never actually failed -- 654 requests, zero non-200s -- but a window
// that long is what let the storefront's variant hider decide a stocked product
// was "Back Soon" from a half-rendered page, and that decision used to stick
// until the shopper reloaded.
//
// The data is tiny and changes rarely: 27 catalog rules, ~1,700 product
// overrides and ~860 location mappings, about 600KB in total against an
// instance that sits at 156MB of its 512MB. So it is all held in memory and
// refreshed in the background, which takes the endpoint from three round trips
// to none.
//
// FRESHNESS
// A rule changed in the admin shows up within REFRESH_MS. That already matched
// reality: the response carries Cache-Control private max-age=60 and the
// storefront keeps its own 60-second TTL, so the admin was never more
// immediate than this.
//
// Refresh is stale-while-revalidate: an expired cache is still served while the
// reload happens behind it, so no shopper ever waits on Oregon. If a reload
// fails the previous data stays in place rather than the endpoint failing.

const REFRESH_MS = 60 * 1000;
// Don't serve from a cache older than this; fall back to the database instead.
// Guards against a refresh that has been failing unnoticed for a long time.
const MAX_STALE_MS = 15 * 60 * 1000;

const clean = (value) => (String(value).includes("/") ? String(value).split("/").pop() : String(value));

/** @type {{ loadedAt: number, rulesByCatalog: Map<string, any>, overridesByKey: Map<string, any>, locationByGid: Map<string, any> } | null} */
let cache = null;
let loading = null;
let lastError = null;

function build(rules, overrides, locations) {
  // A catalog can have more than one rule row, because older versions of this
  // app stored catalogId as gid://shopify/MarketCatalog/<id>,
  // .../CompanyLocationCatalog/<id> and .../AppCatalog/<id> as well as the bare
  // id the admin uses now. Night N Day still has all four. The endpoint's
  // findFirst has no ORDER BY, so which one it serves is whatever Postgres
  // hands back, and for several catalogs that is a March row rather than what
  // the admin says.
  //
  // This cache will NOT pick a winner. Choosing one here would silently change
  // which rule a live catalog gets, in a direction nobody asked for. Any
  // catalog with more than one row is marked ambiguous and every lookup for it
  // falls through to the same database query as before, so behaviour is
  // unchanged until the duplicates are resolved deliberately.
  const rulesByCatalog = new Map();
  const ambiguousCatalogs = new Set();
  for (const row of rules) {
    const key = clean(row.catalogId);
    if (rulesByCatalog.has(key)) ambiguousCatalogs.add(key);
    else rulesByCatalog.set(key, row);
  }
  if (ambiguousCatalogs.size > 0) {
    console.warn(
      `[rules-cache] ${ambiguousCatalogs.size} catalog(s) have duplicate rule rows and will be read from the database: ${[...ambiguousCatalogs].join(", ")}`
    );
  }

  const overridesByKey = new Map();
  for (const row of overrides) {
    const key = `${clean(row.catalogId)}::${clean(row.productId)}`;
    if (!overridesByKey.has(key)) overridesByKey.set(key, row);
  }

  const locationByGid = new Map();
  for (const row of locations) locationByGid.set(row.locationGid, row);

  return { loadedAt: Date.now(), rulesByCatalog, ambiguousCatalogs, overridesByKey, locationByGid };
}

async function load(prisma) {
  const [rules, overrides, locations] = await Promise.all([
    prisma.catalogRule.findMany(),
    prisma.productOverride.findMany(),
    prisma.locationCatalogMap.findMany(),
  ]);
  cache = build(rules, overrides, locations);
  lastError = null;
  return cache;
}

/** Kick off a reload without making the caller wait for it. */
function refreshInBackground(prisma) {
  if (loading) return;
  loading = load(prisma)
    .catch((e) => {
      lastError = e?.message || String(e);
      console.error("[rules-cache] background refresh failed, keeping previous data:", lastError);
    })
    .finally(() => {
      loading = null;
    });
}

/**
 * The cache, or null when there isn't usable data and the caller should go to
 * the database. Only ever awaits on the very first call of a process.
 */
export async function getRulesCache(prisma) {
  if (!cache) {
    if (!loading) {
      loading = load(prisma)
        .catch((e) => {
          lastError = e?.message || String(e);
          console.error("[rules-cache] initial load failed, falling back to the database:", lastError);
          return null;
        })
        .finally(() => {
          loading = null;
        });
    }
    await loading;
    return cache;
  }

  const age = Date.now() - cache.loadedAt;
  if (age > REFRESH_MS) refreshInBackground(prisma);
  // Too old to trust means fall back to the database, not serve stale rules.
  if (age > MAX_STALE_MS) return null;
  return cache;
}

/** Warm at boot so the first shopper of the day doesn't pay for the load. */
export function warmRulesCache(prisma) {
  refreshInBackground(prisma);
}

/**
 * The rule for a catalog.
 *
 * Returns the row, or null when the catalog definitively has no rule, or
 * `undefined` meaning "don't know, ask the database" -- which is what a catalog
 * with duplicate rows gets, so the cache never decides between them.
 */
export function ruleFor(c, catalogId) {
  if (!c || !catalogId) return null;
  const key = clean(catalogId);
  if (c.ambiguousCatalogs.has(key)) return undefined;
  return c.rulesByCatalog.get(key) ?? null;
}

export function overrideFor(c, catalogId, productId) {
  if (!c || !catalogId || !productId) return null;
  return c.overridesByKey.get(`${clean(catalogId)}::${clean(productId)}`) ?? null;
}

export function locationFor(c, locationGid) {
  if (!c || !locationGid) return null;
  return c.locationByGid.get(locationGid) ?? null;
}

/**
 * Record price lists discovered for a location so the cache matches what was
 * just written to the database, instead of looking them up again next request.
 */
export function noteLocationPriceLists(locationGid, priceListIds) {
  if (!cache) return;
  const row = cache.locationByGid.get(locationGid);
  if (row) row.priceListIds = JSON.stringify(priceListIds);
}

/** For the health endpoint. */
export function rulesCacheStatus() {
  if (!cache) return { loaded: false, lastError };
  return {
    loaded: true,
    ageMs: Date.now() - cache.loadedAt,
    rules: cache.rulesByCatalog.size,
    ambiguousCatalogs: [...cache.ambiguousCatalogs],
    overrides: cache.overridesByKey.size,
    locations: cache.locationByGid.size,
    lastError,
  };
}
