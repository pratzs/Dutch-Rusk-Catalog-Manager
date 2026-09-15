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

// Above this many cart lines BOTH Functions stand down, and they must use the
// same number.
//
// Raising prices here is only safe if the paired product discount is certain to
// run afterwards and bring them back down. It isn't, on a big enough cart -- and
// when it doesn't, this Function has already raised every line to retail and the
// buyer pays it. That is what happened to #1409, #1850 and #1884.
//
// The discount Function no longer receives the line cost, so it cannot work out
// for itself whether this one raised a line. Instead both read the same cart and
// apply the same limit to the same line count, which is deterministic. Keep the
// two constants identical: see MAX_LINES_TO_TRANSFORM in
// extensions/b2b-custom-prices/src/run.js.
//
// Measured against an honest worst case (heaviest live data, every line
// discounted, every line a different saving so no two discount rows can share an
// entry), 11M budget:
//
//                      this Function   the discount Function (binding)
//     100 lines        7.57M                9.06M
//     110 lines        8.31M                9.93M   <-- guard, ~10% headroom
//     115 lines        8.68M               10.36M   (5.8%, too thin)
//
// The DISCOUNT Function is the binding side, not this one. Its output also has
// to fit a 19.53KB cap: 14.98KB at 110 lines. DO NOT raise without re-measuring
// BOTH, against a cart where every line has a DIFFERENT saving so no two
// discount rows can share an entry.
const MAX_LINES_TO_TRANSFORM = 110;

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

  // Lookup key into custom.catalog_savings. Every entry in that string is
  // preceded by "|", so this cannot match the tail of a longer price list id.
  const needle = "|" + priceListId.slice(priceListId.lastIndexOf("/") + 1) + ":";

  const operations = [];

  for (let i = 0; i < cartLines.length; i++) {
    const line = cartLines[i];
    const raw = line.merchandise.catSavings?.value;
    // No value at all means this is not a ProductVariant, or the sync has not
    // reached it yet. Either way there is nothing to raise to.
    if (!raw) continue;

    const at = raw.indexOf(needle);
    if (at < 0) continue; // this catalog has no special price for the variant

    // Only raise when there is a genuine saving to hand back. Without this a
    // buyer could be left paying retail if the data were ever wrong.
    const saving = parseFloat(raw.slice(at + needle.length, at + needle.length + 12));
    if (!(saving > 0)) continue;

    // Retail is the leading number of the string; parseFloat stops at the "|".
    const retail = parseFloat(raw);
    if (!(retail > 0)) continue;

    operations.push({
      update: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: retail.toFixed(2),
            },
          },
        },
      },
    });
  }

  return { operations };
}
