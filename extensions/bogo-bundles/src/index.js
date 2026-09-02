// BOGO Bundles — Shopify Function
//
// Applies "Buy X Get Y Free" deals as a real product discount computed on
// top of whatever price already resolved for the line (including B2B
// catalog/price-list pricing). Native Buy X Get Y automatic discounts don't
// work here because a B2B fixed-price catalog override occupies the same
// line discount slot and blocks any other product discount from applying.
// A Function's productDiscountsAdd operation runs against the
// already-resolved line cost instead, so it doesn't compete for that slot.
//
// Config lives entirely in the shop metafield custom.bogo_bundles (JSON),
// so Ryan can add/edit/remove deals monthly from Shopify Admin →
// Settings → Custom data → Shop metafields, with no developer involvement.
//
// Shape of custom.bogo_bundles:
// [
//   { "id": "musashi-10-1", "label": "Buy 10 Get 1 Free", "buyQty": 10, "getQty": 1,
//     "variantIds": ["gid://shopify/ProductVariant/123", ...] }
// ]
//
// Per bundle: sum matching-variant quantities across all cart lines, work out
// how many free units are earned (floor(totalQty / buyQty) * getQty, capped
// at totalQty), then give away that many units for free — cheapest-priced
// matching line(s) first, same convention Shopify's own BXGY discount uses.

/**
 * @param {import("../generated/api").CartInput} input
 * @returns {import("../generated/api").CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const noDiscount = { operations: [] };

  const raw = input?.shop?.bogoBundles?.value;
  if (!raw) return noDiscount;

  let bundles;
  try {
    bundles = JSON.parse(raw);
  } catch {
    return noDiscount;
  }
  if (!Array.isArray(bundles) || bundles.length === 0) return noDiscount;

  const lines = (input.cart.lines ?? []).filter(
    (line) => line.merchandise?.__typename === "ProductVariant"
  );

  const candidates = [];

  for (const bundle of bundles) {
    const buyQty = Number(bundle?.buyQty);
    const getQty = Number(bundle?.getQty);
    const variantIds = Array.isArray(bundle?.variantIds) ? bundle.variantIds : [];
    if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0 || variantIds.length === 0) continue;

    const variantIdSet = new Set(variantIds);
    const matchingLines = lines.filter((line) =>
      variantIdSet.has(line.merchandise.id)
    );
    if (matchingLines.length === 0) continue;

    const totalQty = matchingLines.reduce((sum, line) => sum + line.quantity, 0);
    const groups = Math.floor(totalQty / buyQty);
    if (groups <= 0) continue;

    let freeUnitsRemaining = Math.min(groups * getQty, totalQty);
    if (freeUnitsRemaining <= 0) continue;

    // Cheapest matching line first, so the free units come off the
    // lowest-value items — matches Shopify's own BXGY convention.
    const sortedLines = [...matchingLines].sort((a, b) => {
      const priceA = parseFloat(a.cost?.amountPerQuantity?.amount ?? "0");
      const priceB = parseFloat(b.cost?.amountPerQuantity?.amount ?? "0");
      return priceA - priceB;
    });

    for (const line of sortedLines) {
      if (freeUnitsRemaining <= 0) break;

      const price = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
      if (!price || price <= 0) continue;

      const freeFromThisLine = Math.min(freeUnitsRemaining, line.quantity);
      if (freeFromThisLine <= 0) continue;

      candidates.push({
        message: bundle.label ?? "Buy X Get Y Free",
        targets: [
          {
            cartLine: {
              id: line.id,
              quantity: freeFromThisLine,
            },
          },
        ],
        value: {
          fixedAmount: {
            amount: price.toFixed(2),
            appliesToEachItem: true,
          },
        },
      });

      freeUnitsRemaining -= freeFromThisLine;
    }
  }

  if (!candidates.length) return noDiscount;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
