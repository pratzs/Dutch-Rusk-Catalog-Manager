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
  discountApplicationStrategy: DiscountApplicationStrategy.All,
  discounts: [],
};

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;

  if (!priceListId) {
    return EMPTY_DISCOUNT;
  }

  console.log(`[b2b-custom-prices] Pure Catalog Resolution for List: ${priceListId}`);

  const discounts = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // currentPrice here is the price RAISED to Retail by the Transformer.
    const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // ── THE SOURCE OF TRUTH ──────────────────────────────────────────────────
    // We strictly use the map synced from the Shopify Catalog Price Lists.
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

    // APPLY DISCOUNT: calculate the markdown from currentPrice (Retail) to Target Wholesale.
    // If no target is found, we assume full retail (0 discount).
    if (targetWholesalePrice !== null && currentPrice > targetWholesalePrice + 0.01) {
      const discountAmount = currentPrice - targetWholesalePrice;

      console.log(`Line ${line.id}: CurrentPrice=${currentPrice.toFixed(2)}, TargetWholesale=${targetWholesalePrice.toFixed(2)}, Discount=${discountAmount.toFixed(2)}`);

      discounts.push({
        targets: [
          {
            cartLine: {
              id: line.id,
              quantity: line.quantity,
            },
          },
        ],
        value: {
          fixedAmount: {
            amount: discountAmount.toFixed(2),
            appliesToEachItem: true,
          },
        },
        message: "B2B Wholesale Price",
      });
    }
  }

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.All,
    discounts,
  };
};
