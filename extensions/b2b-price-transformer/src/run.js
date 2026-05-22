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

    // Check for Fixed Override
    const fixedPricesRaw = variant.metafield?.value;
    if (fixedPricesRaw) {
      try {
        const fixedPricesMap = JSON.parse(fixedPricesRaw);
        const fixedPrice = fixedPricesMap[priceListId];
        if (fixedPrice !== undefined && fixedPrice !== null) {
          targetWholesalePrice = parseFloat(fixedPrice);
        }
      } catch (e) {}
    }

    const finalWholesale = targetWholesalePrice ?? currentPrice;
    const finalRetail = (standardRetail > finalWholesale) ? standardRetail : 0;

    // STRATEGY: We RAISE the price to the Retail baseline.
    // The Discount function will then apply the markdown to reach finalWholesale.
    // This triggers the native strikethrough UI.
    if (finalRetail > finalWholesale) {
      console.log(`Raising line ${line.id} to Retail: ${finalRetail.toFixed(2)} (Wholesale target: ${finalWholesale.toFixed(2)})`);
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
