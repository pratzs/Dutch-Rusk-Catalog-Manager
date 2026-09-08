// Which catalogs can actually get a BOGO deal.
//
// The storefront needs this to decide whether to show the "Special Deals" menu
// item. Deals are scoped per catalog in the Catalog Manager BOGO page, so a
// buyer on a catalog no deal targets would otherwise see a menu link to offers
// they cannot have.
//
// The answer is derived from the same custom.bogo_bundles config the Function
// reads, so the menu follows whatever is set in the admin with no second place
// to keep up to date. If a deal is later opened up to another catalog, that
// catalog's buyers start seeing the link within the cache window below.
//
// The config is cached in-process because api.catalog-rules is hit by every
// product card on every page view and the app runs on one small instance --
// one Shopify call per TTL, not per request. A stale answer for a minute or two
// only means the menu item appears or disappears slightly late.
const TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { at: number, value: { anyCatalog: boolean, priceListIds: string[] } }>} */
const cache = new Map();

/** Exposed for tests and for the admin page to drop the cache after a save. */
export function clearDealsCache(shop) {
  if (shop) cache.delete(shop);
  else cache.clear();
}

function parseBundles(raw) {
  let bundles;
  try {
    bundles = JSON.parse(raw ?? "[]");
  } catch {
    return null; // malformed -- caller decides what to do
  }
  if (!Array.isArray(bundles)) return null;

  const priceListIds = new Set();
  let anyCatalog = false;

  for (const bundle of bundles) {
    const ids = Array.isArray(bundle?.catalogIds) ? bundle.catalogIds : [];
    // No catalogIds on a bundle means it is not restricted, so it applies
    // everywhere -- the same reading the Function uses.
    if (ids.length === 0) {
      anyCatalog = true;
      continue;
    }
    for (const id of ids) if (id) priceListIds.add(String(id));
  }

  return { anyCatalog, priceListIds: [...priceListIds] };
}

/**
 * Read the deal scope for a shop, cached.
 *
 * @param {string} shop myshopify domain
 * @param {(query: string) => Promise<any>} gql runs an admin GraphQL query
 * @returns {Promise<{ anyCatalog: boolean, priceListIds: string[] } | null>}
 *   null when the config could not be read or was malformed, which callers must
 *   treat as "don't know" rather than "no deals".
 */
export async function getDealScope(shop, gql) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let raw;
  try {
    const data = await gql(`{ shop { metafield(namespace: "custom", key: "bogo_bundles") { value } } }`);
    raw = data?.shop?.metafield?.value;
  } catch (e) {
    console.error("[deals] could not read bogo_bundles:", e?.message || e);
    // Serve a stale answer rather than nothing -- it is better than flapping
    // the menu on a transient API blip.
    return hit?.value ?? null;
  }

  const parsed = parseBundles(raw);
  if (!parsed) {
    console.error("[deals] bogo_bundles missing or malformed");
    return hit?.value ?? null;
  }

  cache.set(shop, { at: Date.now(), value: parsed });
  return parsed;
}

/**
 * Can a buyer on these price lists get any deal?
 *
 * @param {{ anyCatalog: boolean, priceListIds: string[] } | null} scope
 * @param {string[]} buyerPriceListIds every price list the buyer's location has
 * @returns {boolean | null} null means unknown -- the caller should leave the
 *   storefront as it is rather than guess.
 */
export function isDealEligible(scope, buyerPriceListIds) {
  if (!scope) return null;
  if (scope.anyCatalog) return true;
  if (!Array.isArray(buyerPriceListIds) || buyerPriceListIds.length === 0) return null;
  return buyerPriceListIds.some((id) => scope.priceListIds.includes(String(id)));
}
