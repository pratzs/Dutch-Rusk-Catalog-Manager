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
  // 1. Extract the catalog_pricelist_id from purchasing company metafield
  const priceListId = input.cart.buyerIdentity?.purchasingCompany?.company?.metafield?.value;

  if (!priceListId) {
    return NO_CHANGES;
  }

  const operations = [];

  // 2. Iterate through cart lines
  for (const line of input.cart.lines) {
    const variant = line.merchandise;

    // 3. Check if the merchandise is a ProductVariant
    if (variant.__typename !== "ProductVariant") {
      continue;
    }

    // 4. Parse the custom.catalog_fixed_prices metafield
    const fixedPricesRaw = variant.metafield?.value;
    if (!fixedPricesRaw) {
      continue;
    }

    try {
      const fixedPricesMap = JSON.parse(fixedPricesRaw);
      const fixedPrice = fixedPricesMap[priceListId];

      if (fixedPrice !== undefined && fixedPrice !== null) {
        const catalogPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
        const overridePrice = parseFloat(fixedPrice);
        const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

        // Use standard retail as compareAtPrice to force strikethrough
        // Final transaction price is our overridePrice
        const retailBaseline = (standardRetail > overridePrice) ? standardRetail : catalogPrice;

        operations.push({
          update: {
            cartLineId: line.id,
            price: {
              amount: overridePrice.toFixed(2),
            },
            compareAtPrice: {
              amount: retailBaseline.toFixed(2),
            },
          },
        });
      }
    } catch (e) {
      console.error("Error processing line transformation:", line.id, e);
    }
  }

  return { operations };
};
