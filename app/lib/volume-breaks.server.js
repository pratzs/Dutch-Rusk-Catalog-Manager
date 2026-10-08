// Volume pricing (Shopify quantity price breaks) for the two B2B pricing
// Functions.
//
// A catalog can say "12+ of this variant costs $47.83 each". Shopify honours that
// on its own, but this shop runs a cart transform + discount Function pair that
// sets every B2B line to "retail minus a fixed saving", which ignored quantity,
// so breaks never reached checkout (found 9 Oct 2026, Metromart Bic Lighters).
//
// The fix is data, not a second Function: each break rides inside the price list's
// own entry of custom.catalog_savings, after the base saving:
//
//     80.00|34505457977:18.80@12=32.17@24=36.00|
//                       ^base   ^12+     ^24+      (savings off retail)
//
// The base saving stays a plain number, so a Function that has not been updated
// stops reading at the "@" and prices exactly as before. That is what makes the
// rollout safe in either order: the sync can ship first.

const EPS = 0.005;

/**
 * A variant with ANY volume break gets a "+" in front of its whole catalog_savings
 * string. The discount Function checks that one character per line (cheap) before
 * doing any break maths (expensive); an older Function reads "+27.75" as 27.75.
 * @param {Record<string,string>} savingsByPriceListId entries as built for the string, each "<saving>[@min=saving...]"
 */
export function tierFlag(savingsByPriceListId) {
  for (const k of Object.keys(savingsByPriceListId)) if (savingsByPriceListId[k].indexOf("@") > 0) return "+";
  return "";
}

// A volume break more than 40% below the catalog's own price is treated as a data
// mistake and NOT shipped to the Functions (it would be honoured at checkout).
// The real one that motivated this: a Metromart Bic Lighters Shipper (a case of
// 12 Outers, $734.40) carrying the Outer's "12+ at $47.83" break, 93% off. Real
// volume breaks are single-digit to ~30% off.
export const MAX_BREAK_DEPTH = 0.4;

/**
 * The "@<min>=<saving>" suffix for one variant on one price list, or "".
 * Only breaks that are genuinely deeper than the base price count: a break at or
 * above the base price changes nothing, so it is dropped rather than shipped.
 *
 * @param {number} retail standard retail price
 * @param {number} basePrice the catalog's price at quantity 1
 * @param {{min:number, price:number}[]|undefined} breaks
 * @param {(skipped:{min:number, price:number, basePrice:number}) => void} [onSkip] told about each break rejected as implausible
 */
export function tierSuffix(retail, basePrice, breaks, onSkip) {
  if (!Array.isArray(breaks) || !breaks.length || !(retail > 0)) return "";
  const best = new Map(); // min qty -> lowest price at that qty
  for (const b of breaks) {
    const min = Math.floor(Number(b?.min));
    const price = Number(b?.price);
    if (!Number.isFinite(min) || min < 2 || !Number.isFinite(price) || price <= 0) continue;
    if (price >= basePrice - EPS || price >= retail - EPS) continue;
    if (price < basePrice * (1 - MAX_BREAK_DEPTH)) { if (onSkip) onSkip({ min, price, basePrice }); continue; }
    if (!best.has(min) || price < best.get(min)) best.set(min, price);
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([min, price]) => `@${min}=${(retail - price).toFixed(2)}`)
    .join("");
}

const BREAKS_QUERY = `query PriceListBreaks($id: ID!, $cursor: String) {
  priceList(id: $id) {
    prices(first: 100, after: $cursor, originType: FIXED) {
      pageInfo { hasNextPage endCursor }
      nodes {
        variant { id }
        quantityPriceBreaks(first: 5) {
          pageInfo { hasNextPage }
          nodes { minimumQuantity price { amount } }
        }
      }
    }
  }
}`;

/**
 * Every quantity break on one price list: { variantGid: [{min, price}] }.
 * Only variants that HAVE breaks are included.
 *
 * `exec(query, variables)` must resolve to the raw GraphQL JSON ({data, errors}).
 * A failed or throttled page is retried, then THROWS: returning a partial answer
 * would silently drop customers' volume prices on the next sync.
 */
export async function fetchListBreaks(exec, priceListId, { log = () => {} } = {}) {
  const out = {};
  let cursor = null;
  do {
    let json;
    for (let attempt = 0; ; attempt++) {
      json = await exec(BREAKS_QUERY, { id: priceListId, cursor });
      const throttled = json?.errors?.some((e) => e?.extensions?.code === "THROTTLED");
      if (!throttled && !json?.errors?.length) break;
      if (attempt >= 6) throw new Error(`price list breaks ${priceListId}: ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
    const page = json?.data?.priceList?.prices;
    if (!page) throw new Error(`price list breaks ${priceListId}: no price page returned`);
    for (const n of page.nodes) {
      const nodes = n.quantityPriceBreaks?.nodes ?? [];
      if (!nodes.length || !n.variant?.id) continue;
      if (n.quantityPriceBreaks.pageInfo?.hasNextPage) log(`[volume-breaks] ${n.variant.id} has more than 5 breaks on ${priceListId}; only the first 5 are used`);
      out[n.variant.id] = nodes.map((b) => ({ min: b.minimumQuantity, price: parseFloat(b.price.amount) }));
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

/** Stable text form of one list's breaks, for noticing changes between runs. */
export function breaksSnapshot(byVariant) {
  const snap = {};
  for (const [vid, bs] of Object.entries(byVariant)) {
    snap[vid] = bs.slice().sort((a, b) => a.min - b.min).map((b) => `${b.min}=${b.price.toFixed(2)}`).join(";");
  }
  return snap;
}

/** Variant ids whose breaks differ between two snapshots (added, changed or removed). */
export function changedVariants(prev, next) {
  const out = new Set();
  for (const k of new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])) {
    if ((prev ?? {})[k] !== (next ?? {})[k]) out.add(k);
  }
  return [...out];
}

/** Inverse of breaksSnapshot: { variantGid: "12=47.83;24=44.00" } -> { variantGid: [{min, price}] }. */
export function parseSnapshot(snap) {
  const out = {};
  for (const [vid, text] of Object.entries(snap ?? {})) {
    const bs = String(text).split(";").map((p) => p.split("=")).filter((p) => p.length === 2).map(([m, pr]) => ({ min: Number(m), price: Number(pr) }));
    if (bs.length) out[vid] = bs;
  }
  return out;
}

/**
 * Daily check: have volume breaks changed since the last sync applied them?
 * Reads every price list live and compares with the snapshot the sync stored.
 * Returns { changed, variants, snapshot }. No stored snapshot counts as changed,
 * which is what makes the first run after a deploy write the tiers everywhere.
 */
export async function breaksChangedSinceLastSync(gql, prisma, shop, priceListIds, { log = () => {} } = {}) {
  const exec = async (query, variables) => ({ data: await gql(query, variables) });
  const row = await prisma.catalogSyncState.findUnique({ where: { shop_priceListId: { shop, priceListId: "BREAKS_SNAPSHOT" } } });
  let stored = null;
  try { stored = row ? JSON.parse(row.overriddenVariantIds) : null; } catch { stored = null; }
  const live = {};
  for (const id of priceListIds) live[id] = breaksSnapshot(await fetchListBreaks(exec, id, { log }));
  if (!stored) return { changed: true, variants: [], snapshot: live, reason: "no stored snapshot" };
  const variants = [];
  for (const id of priceListIds) variants.push(...changedVariants(stored[id] ?? null, live[id]));
  const gone = Object.keys(stored).some((id) => !priceListIds.includes(id));
  return { changed: variants.length > 0 || gone || priceListIds.some((id) => !(id in stored)), variants, snapshot: live, reason: variants.length ? `${variants.length} variant(s) changed` : "list added or removed" };
}
