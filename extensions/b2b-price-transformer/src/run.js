// @ts-check
//
// ⚠️  UNREGISTERED AS OF 2026-09-07 — this Function no longer runs.
//
// Its CartTransform (gid://shopify/CartTransform/131301689) was deleted so that
// Shopify prices B2B carts natively from the catalog price lists, with no
// Function in the pricing path at all.
//
// Why it had to go: this Function raised every line to retail so a paired
// discount Function could bring it back down, which made a correct price depend
// on BOTH Functions finishing. Shopify Functions get 11M instructions, and a
// cart burns roughly 0.16M per line — so past ~57 lines the discount died, this
// one had already raised the prices, and the buyer paid full retail (#1409,
// #1850, #1884: $1,632 above catalog). Even just RECEIVING a 300-line cart costs
// 13.3M, over the budget. No guard value, optimisation or payload pruning gets
// this design to the 100-200 line carts the business expects.
//
// Native catalog pricing has no such ceiling because none of our code runs. The
// storefront display survived the change because the theme was already written
// for it: sections/main-cart.liquid falls back to
// `item.variant.compare_at_price` when there is no discount, for line prices,
// line totals and the cart total, and snippets/price.liquid uses compare-at on
// product and collection pages. Checkout savings come from the
// standard_retail_price metafield via the checkout-price-display extension.
//
// DO NOT re-register this without re-reading the above. If it is ever needed
// again, recreate the CartTransform and note that the guard below was measured
// against the 11M budget and must be re-measured with `shopify app function run`
// before being raised.
//
/**
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 */

/**
 * @type {FunctionRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
// Above this many cart lines this Function stands down completely.
//
// Raising prices here is only safe if the paired product discount ("B2B
// Wholesale Custom Pricing") is certain to run afterwards and bring them back
// to the catalog price. It isn't, on a big enough cart -- and when it doesn't,
// this Function has already raised every line to retail and the buyer pays it.
// That is what happened to #1409 (47 lines), #1850 (48) and #1884 (59):
// $1,632 above catalog.
//
// The binding limit is INSTRUCTIONS, not input size. Measured with the real
// Shopify function runner against the actual wasm, using order #1884's own
// lines and a pruned price map, against the 11M budget:
//
//     35 lines  6.96M      50 lines   9.59M
//     40 lines  7.78M      55 lines  10.40M
//     45 lines  8.81M      60 lines  11.36M  <-- over, Function killed
//
// (Input size is capped at 125KB and never came close; the largest cart tested
// was 47KB. An earlier guess that input size was the cause was wrong, and a
// "faster" hand-rolled string scan to replace JSON.parse measured SLOWER in
// QuickJS -- 12.43M at 60 lines -- so it was reverted.)
//
// 40 sits ~29% under the ceiling, which is the margin for carts heavier than
// #1884's: bigger price maps, more BOGO matches, higher quantities. Standing
// down inverts the failure -- the line keeps Shopify's own catalog price,
// which is the correct price. A cart above this loses only the struck-through
// "was" price, never the amount charged.
//
// Raising this number is not a free win: it must be re-measured with
// `shopify app function run` first. Switching BOGO off would free ~1.5-2M
// instructions (the config parse) and support roughly 55.
const MAX_LINES_TO_TRANSFORM = 40;

export function run(input) {
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;

  if (!priceListId) {
    return NO_CHANGES;
  }

  if (input.cart.lines.length > MAX_LINES_TO_TRANSFORM) {
    return NO_CHANGES;
  }

  const operations = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // ── GATHER TRUTH ────────────────────────────────────────────────────────
    // We strictly use the map synced from the Shopify Catalog Price Lists.
    const fixedPricesRaw = variant.fixedPrices?.value;
    if (fixedPricesRaw) {
      try {
        const fixedPricesMap = JSON.parse(fixedPricesRaw);
        const fixedPrice = fixedPricesMap[priceListId];
        if (fixedPrice !== undefined && fixedPrice !== null) {
          targetWholesalePrice = parseFloat(fixedPrice);
        }
      } catch (e) {
        // malformed fixedPrices JSON — no wholesale target this run
      }
    }

    const finalWholesale = targetWholesalePrice;
    
    // ── GUARANTEED PRECISION ────────────────────────────────────────────────
    // We ONLY RAISE the price if we are 100% CERTAIN we have a wholesale 
    // target to discount back down to. This prevents customers from 
    // accidentally paying full retail if the sync is delayed.
    if (finalWholesale !== null && standardRetail > finalWholesale) {
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: standardRetail.toFixed(2),
              }
            }
          }
        },
      });
    }
  }

  return { operations };
}
