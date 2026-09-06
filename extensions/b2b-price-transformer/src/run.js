// @ts-check

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
// It exists because raising prices here is only safe if the paired product
// discount ("B2B Wholesale Custom Pricing") is certain to run afterwards and
// bring them back to the catalog price. Both Functions are capped on input
// size, and the discount's input is the larger of the two -- it also carries
// the BOGO config -- so it gives out FIRST. That left a band of cart sizes
// where this Function raised every line to retail and nothing pulled it back,
// and the customer paid full retail: orders #1409 (47 lines), #1850 (48) and
// #1884 (59) were charged $1,632 above catalog that way.
//
// Standing down early inverts the failure: the line keeps Shopify's own
// catalog price, which is the correct price. The only thing lost on a very
// large cart is the struck-through "was" price, never the amount charged.
// Measured: the discount Function handled 41 lines and failed at 47 while the
// price map still held all 12 price lists. Pruning that map to genuine
// discounts roughly halved its input, so 60 leaves a wide margin, and it
// covers 99.7% of B2B orders placed so far (350 of 351).
const MAX_LINES_TO_TRANSFORM = 60;

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
