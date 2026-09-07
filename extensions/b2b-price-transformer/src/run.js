// @ts-check
//
// ACTIVE. Registered as gid://shopify/CartTransform/162660665.
//
// This Function raises each B2B line to its retail price so the paired product
// discount ("B2B Wholesale Custom Pricing") can take it back down to the
// catalog price. That round trip is what produces the visible saving the
// business runs on: the struck-through "was" price and the explicit
// "B2B Wholesale Price" discount rows on the cart, at checkout, and on the
// order in the admin (see order #1892 for the intended result).
//
// It was briefly removed on 2026-09-07 in favour of Shopify's native catalog
// pricing, which has no cart-size ceiling. That priced correctly but produced
// orders with no discount lines at all, which is not acceptable — the discount
// rows are a requirement, not a side effect. Reverted the same day.
//
// The cost of keeping this design is the ceiling below. Read the guard comment
// before touching it: the limit is real, measured, and it is what caused
// #1409, #1850 and #1884 to bill full retail.
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
