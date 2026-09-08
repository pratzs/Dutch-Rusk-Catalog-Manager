// Decides whether an order's discount rows are acceptable.
//
// Kept separate from the webhook so it can be tested against real orders. It
// went wrong once already in a way no test would have caught: the missing-rows
// check excluded any cart over the transform's line guard, on the grounds that
// a missing row there is expected. It is expected, but it is not acceptable --
// the rule on this shop is that no order goes out without its struck-through
// price -- and that exclusion is why #1904 (65 lines), #1914 (48) and #1920
// (56) all went out with zero discount rows and alerted nobody.

/** Cart lines above this and b2b-price-transformer stands down on purpose. */
export const TRANSFORM_LINE_GUARD = 45;

/**
 * @param {object} args
 * @param {Array} args.lineItems              order.line_items from the webhook
 * @param {Record<string, {price:number, sku?:string}>} args.catalogByVariant
 *   Shopify's own contextual price per numeric variant id
 * @param {Record<string, number>} args.retailByVariant  standard_retail_price
 * @param {Set<string>} args.dealVariantIds   numeric ids in a BOGO bundle
 * @param {number} [args.guard]
 */
export function classifyPricingRows({
  lineItems,
  catalogByVariant,
  retailByVariant,
  dealVariantIds,
  guard = TRANSFORM_LINE_GUARD,
}) {
  let allocatedTotal = 0;
  let discountWasAvailable = false;
  let linesWithSaving = 0;
  let linesWithSavingNoRow = 0;
  let skippedDealLines = 0;

  for (const li of lineItems ?? []) {
    if (!li.variant_id) continue;
    const key = String(li.variant_id);
    const lineAllocated = (li.discount_allocations ?? []).reduce(
      (s, d) => s + parseFloat(d.amount ?? "0"),
      0
    );
    allocatedTotal += lineAllocated;

    const cat = catalogByVariant[key];
    const retail = retailByVariant[key];
    // A saving only counts if Shopify's own catalog price for this buyer is
    // genuinely under the retail price. Equal prices are not a missed discount.
    const savingOnThisLine =
      !!cat && isFinite(cat.price) && isFinite(retail) && cat.price < retail - 0.011;
    if (savingOnThisLine) discountWasAvailable = true;

    // Deal lines are exempt: a BOGO deliberately prices paid units above
    // catalog because the free unit is the discount, so they would flag every
    // legitimate deal order.
    if (dealVariantIds?.has(key)) {
      skippedDealLines++;
      continue;
    }

    if (savingOnThisLine) {
      linesWithSaving++;
      if (lineAllocated <= 0.005) linesWithSavingNoRow++;
    }
  }

  const lineCount = (lineItems ?? []).filter((li) => li.variant_id).length;
  const overGuard = lineCount > guard;
  const missingRows = discountWasAvailable && allocatedTotal <= 0.005;
  // Some lines struck and others not. A whole-order discount total cannot see
  // this at all -- #1913 had 9 of 48 lines struck and looked fine by total.
  const partialRows = !missingRows && linesWithSavingNoRow > 0;

  return {
    lineCount,
    overGuard,
    missingRows,
    partialRows,
    linesWithSaving,
    linesWithSavingNoRow,
    linesStruck: linesWithSaving - linesWithSavingNoRow,
    discountWasAvailable,
    allocatedTotal,
    skippedDealLines,
    shouldAlert: missingRows || partialRows,
  };
}
