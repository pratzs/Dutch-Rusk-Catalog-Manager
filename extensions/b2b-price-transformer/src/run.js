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
export function run(input) {
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;
  const discountPct = parseFloat(company?.discountPct?.value ?? "0");

  if (!priceListId) {
    return NO_CHANGES;
  }

  const operations = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // 1. Check for Fixed Override
    const fixedPricesRaw = variant.fixedPrices?.value;
    if (fixedPricesRaw) {
      try {
        const fixedPricesMap = JSON.parse(fixedPricesRaw);
        const fixedPrice = fixedPricesMap[priceListId];
        if (fixedPrice !== undefined && fixedPrice !== null) {
          targetWholesalePrice = parseFloat(fixedPrice);
        }
      } catch (e) {}
    }

    // 2. Fallback to Blanket Percentage
    if (targetWholesalePrice === null && discountPct > 0) {
      const baseline = (standardRetail > 0) ? standardRetail : currentPrice;
      targetWholesalePrice = baseline * (1 - discountPct / 100);
    }

    const finalWholesale = targetWholesalePrice ?? currentPrice;
    const finalRetail = (standardRetail > finalWholesale) ? standardRetail : 0;

    // STRATEGY: We RAISE the price to the Retail baseline.
    // The Discount function (b2b-custom-prices) will then apply the markdown.
    // This sequence triggers the native Shopify strikethrough UI.
    if (finalRetail > finalWholesale) {
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            amount: finalRetail.toFixed(2),
          },
        },
      });
    }
  }

  return { operations };
};
