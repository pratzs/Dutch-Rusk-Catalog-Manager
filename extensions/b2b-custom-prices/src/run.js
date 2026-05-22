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
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;
  const discountPct = parseFloat(company?.discountPct?.value ?? "0");

  if (!priceListId) {
    return EMPTY_DISCOUNT;
  }

  const discounts = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // The currentPrice here will be the price RAISED to Retail by the Transformer.
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

    // APPLY DISCOUNT: calculate the markdown from currentPrice (Retail) to Target Wholesale
    if (targetWholesalePrice !== null && currentPrice > targetWholesalePrice) {
      const discountAmount = currentPrice - targetWholesalePrice;

      if (discountAmount > 0.001) {
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
  }

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.First,
    discounts,
  };
};
