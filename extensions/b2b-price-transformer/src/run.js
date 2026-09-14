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
// Measured 2026-09-14 against the rebuilt Functions, worst case, 11M budget
// (lines drawn from the heaviest live price strings, deals past 65 skipped):
//
//     65 lines   8.46M   (23% headroom)
//     70 lines   9.08M   (17% headroom)
//     75 lines   9.70M   (12% headroom)  <-- guard set here
//     80 lines  10.33M   ( 6% headroom)
//     85 lines  10.96M   OVER in all but name
//
// 75 rather than 80 because they cover exactly the same orders -- no order on
// this store has ever had between 73 and 81 lines -- and 75 leaves twice the
// margin. Each new customer catalog lengthens every price string and eats into
// it, so the slack is what lets catalogs be onboarded without this becoming
// unsafe again.
//
// Real carts are lighter than the worst case: the heaviest real orders on the
// store measure #1904 (65 lines) 8.39M, #1374 (72) 9.23M, #1986 (82) 10.62M.
//
// Coverage: 377 of the 380 B2B orders placed since 1 June 2026 are 75 lines or
// fewer (99.2%). At the old guard of 45 it was 362 (95.3%). The two that still
// miss out are #1986 (82 lines) and #1397 (104).
const MAX_LINES_TO_TRANSFORM = 75;

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
