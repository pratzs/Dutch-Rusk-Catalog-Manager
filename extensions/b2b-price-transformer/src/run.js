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

// Raising prices here is only safe if the paired product discount is certain to
// run afterwards and bring them back down. On a big enough cart it is not -- and
// when it fails, this Function has already raised every line to retail and the
// buyer pays it. That is what happened to #1409, #1850 and #1884. So on big
// carts this Function raises only as many lines as BOTH Functions can afford.
// (History: a fixed limit of 108 lines until 16 Nov 2026. See the budget below.)

// ── The shared budget for big carts (above WIDE_FROM lines) ──────────────────
//
// THESE CONSTANTS AND THE WALK THAT USES THEM MUST BE IDENTICAL IN
// b2b-price-transformer/src/run.js AND b2b-custom-prices/src/run.js.
//
// Until 16 Nov 2026 both Functions simply stood down above 108 lines. Night n Day
// stores then started sending 119-126 line carts (#3041, #3283, #3285, #3331),
// which came through at the right price but with no discount rows at all.
//
// A fixed line count was the wrong measure. What a big cart costs is mostly the
// OUTPUT: about 0.046M instructions for every discount entry, against 0.027M for
// one more line sharing an entry that already exists. Real carts repeat the same
// saving on many lines (#3331: 126 lines, 51 different savings), so the discount
// Function now puts every line with the same saving under ONE entry, and the
// limit is a budget in thousands of instructions rather than a line count.
//
// Both Functions walk the cart in the same order and add up what the pair would
// spend. A line is raised (and discounted) only while both totals stay inside
// BUDGET. The first line that would not fit ends it: that line and every line
// after it keep Shopify's native catalog price, which is correct, they just have
// no discount row. So an enormous cart degrades to "most lines have rows"
// rather than "none do", and neither Function can be killed for cost.
//
// The walk depends only on the line count and each line's catalog_savings
// string, which both Functions receive, so they always agree on which lines are
// in. Coefficients are measured with `shopify app function run`, rounded UP.
// Re-measure before changing any of them (docs/B2B-PRICING.md).
const WIDE_FROM = 65; // same number as MAX_LINES_FOR_DEALS
const BUDGET = 10600; // thousands of instructions; the platform limit is 11,000
const D_FIXED = 400; // discount Function: fixed cost
const D_PER_LINE = 26; //   every cart line, covered or not (receive + loop)
const D_PER_TARGET = 27; //   every covered line
const D_PER_ENTRY = 46; //   every DIFFERENT saving among covered lines
const D_TIER_RESERVE = 460; //   volume breaks can split up to 10 lines into their own entries
const T_FIXED = 250; // cart transform: fixed cost
const T_PER_LINE = 26; //   every cart line, covered or not
const T_PER_OP = 52; //   every covered line
// Past this many lines nothing has been measured, so both stand down as before.
const MAX_LINES_TO_TRANSFORM = 250;

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

  const n = cartLines.length;
  const wide = n > WIDE_FROM;
  let dCost = D_FIXED + D_TIER_RESERVE + D_PER_LINE * n;
  let room = Math.floor((BUDGET - T_FIXED - T_PER_LINE * n) / T_PER_OP);
  // One byte per possible saving in cents. A typed array is far cheaper to
  // index than an object; a saving of $655.36 or more simply counts as new
  // every time, and the discount Function counts it the same way.
  const seen = wide ? new Uint8Array(65536) : null;

  for (let i = 0; i < n; i++) {
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

    // Big carts: stop raising at the first line the pair cannot afford. The
    // discount Function runs this same walk and stops at the same line, so this
    // block must come BEFORE anything the discount Function does not also test.
    if (wide) {
      const cents = (saving * 100 + 0.5) | 0;
      if (cents > 65535 || seen[cents] === 0) {
        dCost += D_PER_TARGET + D_PER_ENTRY;
        if (cents <= 65535) seen[cents] = 1;
      } else {
        dCost += D_PER_TARGET;
      }
      if (dCost > BUDGET || --room < 0) break;
    }

    // Retail is the leading number of the string, written by the sync as plain
    // 2dp text with an optional "+" flag in front. It is passed through as text:
    // parsing and re-formatting it cost about 3k instructions a line.
    const bar = raw.indexOf("|");
    const start = raw.charCodeAt(0) === 43 ? 1 : 0;
    if (bar <= start) continue;
    // A price that starts with a zero is rare (under $1); only then is it worth
    // parsing to be sure it is not zero.
    if (raw.charCodeAt(start) === 48 && !(parseFloat(raw) > 0)) continue;

    operations.push({
      update: {
        cartLineId: line.id,
        price: { adjustment: { fixedPricePerUnit: { amount: raw.slice(start, bar) } } },
      },
    });
  }

  return { operations };
}
