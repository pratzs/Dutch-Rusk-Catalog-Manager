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
  const discountPct = parseFloat(company?.discountPct?.value ?? "0");

  if (!priceListId) {
    return EMPTY_DISCOUNT;
  }

  console.log(`[b2b-custom-prices] Run for List: ${priceListId} | Blanket: ${discountPct}%`);

  const discounts = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // currentPrice here is the price RAISED to Retail by the Transformer.
    const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // 1. Check for Fixed Override (Priority 1)
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

    // 2. Fallback to blanket percentage calculation (Priority 2)
    if (targetWholesalePrice === null && discountPct > 0) {
      const baseline = (standardRetail > 0) ? standardRetail : currentPrice;
      targetWholesalePrice = baseline * (1 - discountPct / 100);
    }

    // ── 3. PRICE GUARD ───────────────────────────────────────────────────────
    // If the final wholesale price is lower than the price Shopify naturally 
    // calculated for the catalog, we should favor the catalog price unless 
    // it was an explicit fixed override.
    // NOTE: Because the Transformer raised the price, we can't easily see the 
    // original catalog price here. However, we know that if we haven't found 
    // a target yet, the discount should be 0.
    
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
