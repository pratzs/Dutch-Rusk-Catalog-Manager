// BOGO Bundles — Shopify Function (Product Discount API)
//
// Applies "Buy X Get Y Free" deals as a real per-line discount. Built on the
// deprecated purchase.product-discount.run target (not the newer unified
// cart.lines.discounts.generate.run) because this shop's checkout was
// verified to actually execute that target -- confirmed by the sibling
// b2b-custom-prices extension's live "B2B Wholesale Price" discount, which
// uses the same deprecated API and applies correctly on every order. The
// unified Discount API target was built, deployed and activated correctly
// but never once fired at checkout on this shop, even for a trivial
// always-on 1-cent test discount -- so this target was chosen because it's
// proven to work here, not out of preference.
//
// Config lives entirely in the shop metafield custom.bogo_bundles (JSON),
// so Ryan can add/edit/remove deals monthly via the app's BOGO Bundles page,
// with no developer involvement.
//
// Shape of custom.bogo_bundles:
// [
//   { "id": "musashi-10-1", "label": "Buy 10 Get 1 Free", "buyQty": 10, "getQty": 1,
//     "variantIds": ["gid://shopify/ProductVariant/123", ...] }
// ]

const EMPTY_DISCOUNT = {
  discountApplicationStrategy: "ALL",
  discounts: [],
};

/**
 * @param {import("../generated/api").RunInput} input
 * @returns {import("../generated/api").FunctionRunResult}
 */
export function run(input) {
  const raw = input?.shop?.bogoBundles?.value;
  if (!raw) return EMPTY_DISCOUNT;

  let bundles;
  try {
    bundles = JSON.parse(raw);
  } catch {
    return EMPTY_DISCOUNT;
  }
  if (!Array.isArray(bundles) || bundles.length === 0) return EMPTY_DISCOUNT;

  const lines = (input.cart.lines ?? []).filter(
    (line) => line.merchandise?.__typename === "ProductVariant"
  );

  const discounts = [];

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
    // lowest-value items -- matches Shopify's own BXGY convention.
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

      discounts.push({
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

  if (!discounts.length) return EMPTY_DISCOUNT;

  return {
    discountApplicationStrategy: "ALL",
    discounts,
  };
}
