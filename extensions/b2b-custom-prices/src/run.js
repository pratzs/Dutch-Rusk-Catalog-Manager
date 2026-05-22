// @ts-check
import { DiscountApplicationStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 */

/**
 * @type {FunctionRunResult}
 */
const EMPTY_DISCOUNT = {
  discountApplicationStrategy: DiscountApplicationStrategy.First,
  discounts: [],
};

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  // 1. Extract the catalog_pricelist_id from purchasing company metafield
  const priceListId = input.cart.buyerIdentity?.purchasingCompany?.company?.metafield?.value;

  if (!priceListId) {
    return EMPTY_DISCOUNT;
  }

  const discounts = [];

  // 2. Iterate through cart lines
  for (const line of input.cart.lines) {
    const variant = line.merchandise;

    // 3. Check if the merchandise is a ProductVariant
    if (variant.__typename !== "ProductVariant") {
      continue;
    }

    // 4. Parse the custom.catalog_fixed_prices metafield (which is a JSON string map)
    const fixedPricesRaw = variant.metafield?.value;
    if (!fixedPricesRaw) {
      continue;
    }

    try {
      const fixedPricesMap = JSON.parse(fixedPricesRaw);

      // 5. Look up the catalog_pricelist_id inside that JSON map to find the fixedPrice
      const fixedPrice = fixedPricesMap[priceListId];

      if (fixedPrice !== undefined && fixedPrice !== null) {
        const basePrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
        const overridePrice = parseFloat(fixedPrice);

        // 6. Calculate the discount amount: current unit price - fixedPrice
        const discountAmount = basePrice - overridePrice;

        if (discountAmount > 0.001) {
          discounts.push({
            targets: [
              {
                cartLine: {
                  id: line.id,
                },
              },
            ],
            value: {
              fixedAmount: {
                amount: discountAmount.toFixed(2),
              },
            },
            message: "Wholesale Custom Price",
          });
        }
      }
    } catch (e) {
      // Robust against invalid JSON
      console.error("Error parsing fixed prices for variant:", variant.id, e);
    }
  }

  // 7. Return the discount results
  return {
    discountApplicationStrategy: DiscountApplicationStrategy.First,
    discounts,
  };
};
