// @ts-check
//
// ACTIVE. Registered as a cart transform against this app's Function id.
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
// orders with no discount lines at all, which is not acceptable -- the discount
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

// Above this many cart lines this Function stands down completely.
//
// Raising prices here is only safe if the paired product discount ("B2B
// Wholesale Custom Pricing") is certain to run afterwards and bring them back
// to the catalog price. It isn't, on a big enough cart -- and when it doesn't,
// this Function has already raised every line to retail and the buyer pays it.
// That is what happened to #1409 (47 lines), #1850 (48) and #1884 (59).
//
// The binding limit is INSTRUCTIONS, not input size. The discount Function is
// the one that runs out first, so its cost sets this guard, not this Function's
// own (much cheaper) one. Worst case = lines drawn from the largest live price
// strings, every line matching a BOGO bundle, quantities set so all five deals
// activate.
//
// DO NOT raise without re-measuring: `shopify app function run --input <cart>`
// inside extensions/b2b-custom-prices prints Instructions against the limit.
// Adding a customer catalog makes every price string longer and erodes the
// headroom, so re-measure when one is onboarded.
//
// Measured 2026-09-15 against an honest worst case: lines drawn from the
// heaviest live price strings, EVERY line discounted, and every line a
// DIFFERENT per-unit saving so no two discount rows can share an entry.
//
//     75 lines   9.74M   (11.5% headroom)
//     80 lines  10.37M   ( 5.7% headroom)  <-- guard set here
//     85 lines  11.00M   (no headroom at all)
//     90 lines  11.63M   OVER, Function killed
//
// 80 is the practical end of this architecture. Per-line cost is ~0.125M and is
// structural -- it barely moves with the length of the data -- so 11M / 0.125M
// puts the arithmetic ceiling near 88 lines at zero margin.
//
// Real carts are cheaper than this bound (order #1986's real 82 lines measure
// 10.62M and would fit) but the guard cannot be set on the average case: going
// over bills the buyer FULL RETAIL.
//
// Two things were measured and rejected rather than shipped, both recorded in
// docs/B2B-PRICING.md so they are not retried:
//   - shortening the catalog keys inside the price string: 0.3%, not 1M
//   - grouping discount rows by amount: helps real carts, but costs MORE on a
//     cart where no two savings match, which is the case the guard must hold
//
// Coverage: 378 of the 380 B2B orders placed since 1 June 2026 are 80 lines or
// fewer (99.5%). At the old guard of 45 it was 362 (95.3%). The two that still
// miss out are #1986 (82 lines) and #1397 (104).
//
// DO NOT raise without re-measuring: `shopify app function run --input <cart>`
// inside extensions/b2b-custom-prices prints Instructions against the limit.
const MAX_LINES_TO_TRANSFORM = 80;

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;

  if (!priceListId) {
    return NO_CHANGES;
  }

  const cartLines = input.cart.lines;
  if (cartLines.length > MAX_LINES_TO_TRANSFORM) {
    return NO_CHANGES;
  }

  // Lookup key into the compact price string, built once per run. See the
  // matching comment in extensions/b2b-custom-prices/src/run.js -- both
  // Functions read custom.catalog_prices_v2 and must agree line for line.
  const needle = "|" + priceListId.slice(priceListId.lastIndexOf("/") + 1) + ":";

  const operations = [];

  for (let i = 0; i < cartLines.length; i++) {
    const line = cartLines[i];
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    // ── GATHER TRUTH ────────────────────────────────────────────────────────
    // We strictly use the prices synced from the Shopify Catalog Price Lists.
    let targetWholesalePrice = NaN;
    const raw = variant.catPrices?.value;
    if (raw) {
      const at = raw.indexOf(needle);
      if (at >= 0) {
        const from = at + needle.length;
        targetWholesalePrice = parseFloat(raw.slice(from, from + 12));
      }
    }

    // ── GUARANTEED PRECISION ────────────────────────────────────────────────
    // We ONLY RAISE the price if we are 100% CERTAIN we have a wholesale
    // target to discount back down to. This prevents customers from
    // accidentally paying full retail if the sync is delayed.
    if (targetWholesalePrice === targetWholesalePrice && standardRetail > targetWholesalePrice) {
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: standardRetail.toFixed(2),
              },
            },
          },
        },
      });
    }
  }

  return { operations };
}
