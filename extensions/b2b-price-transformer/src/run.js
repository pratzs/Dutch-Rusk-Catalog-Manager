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
// The binding limit is INSTRUCTIONS, not input size. Input is capped at 125KB
// and never came close (largest cart tested: 47KB). Measured with the real
// Shopify function runner against the actual wasm, against the 11M budget.
//
// WORST CASE -- 45 lines drawn from the 200 largest live price maps (up to
// 553B each, vs a 47B median), every line matching a BOGO bundle, quantity 22
// so all five deals activate and allocate:
//
//     40 lines   9.25M   (16% headroom)
//     45 lines  10.04M   ( 9% headroom)   <-- guard set here
//     50 lines  10.93M   (0.6% headroom)  <-- effectively at the limit
//     55 lines  11.73M   OVER, Function killed
//
// A typical cart is far lighter -- order #1884's own 45 lines measure 8.81M --
// so 9% worst-case headroom is really ~20% in practice. 50 was rejected: 0.6%
// is not a margin, and when this Function is killed the buyer pays FULL RETAIL
// because the transform has already raised the prices (that is what happened
// to #1409, #1850 and #1884: $1,632 above catalog).
//
// The per-line cost is dominated by JSON.parse of the price map, so the way to
// raise this number is to shrink that map, NOT to nudge the guard up. Shortening
// the map keys (dropping the "gid://shopify/PriceList/" prefix, 48 bytes/entry
// down to 21) would roughly halve it and support ~70 lines, but it needs a
// coordinated change to both Functions and the sync, so it is not done here.
//
// Standing down inverts the failure: the line keeps Shopify's own catalog
// price, which is correct. A cart above this still shows a struck-through "was"
// price -- sections/main-cart.liquid falls back to item.variant.compare_at_price
// -- it just loses the explicit "B2B Wholesale Price" discount row.
//
// DO NOT raise without re-measuring: `shopify app function run --input <cart>`
// inside extensions/b2b-custom-prices prints Instructions against the limit.
const MAX_LINES_TO_TRANSFORM = 45;

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
