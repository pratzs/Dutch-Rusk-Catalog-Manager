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

  console.log(`[b2b-custom-prices] Run for List: ${priceListId} | Blanket: ${discountPct}%`);

  const discounts = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // The currentPrice here will be the price RAISED to Retail by the Transformer.
    const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // 1. Check for Fixed Override in metafields
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

    // 2. Fallback to blanket percentage calculation
    if (targetWholesalePrice === null && discountPct > 0) {
      const baseline = (standardRetail > 0) ? standardRetail : currentPrice;
      targetWholesalePrice = baseline * (1 - discountPct / 100);
    }

    // ── 3. UNIVERSAL FALLBACK ───────────────────────────────────────────────
    // If the Transformer raised the price to Retail ($31.30) but we still 
    // haven't found a target wholesale price, we check if the retail price 
    // is significantly higher than the current price. 
    // This happens if the sync tool haven't populated the metafields yet.
    if (targetWholesalePrice === null && standardRetail > 0 && currentPrice >= standardRetail - 0.01) {
        // We know this item IS B2B (because we have a priceListId).
        // If we don't have a specific target, we assume the B2B price should 
        // be what it was BEFORE we raised it.
        // But we don't know what that was. 
        // For now, let's just log this case.
        console.log(`Line ${line.id}: Raised to Retail but no target found. MetaValue: ${fixedPricesRaw}`);
    }

    // APPLY DISCOUNT: calculate the markdown from currentPrice (Retail) to Target Wholesale
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
    } else {
      console.log(`Line ${line.id}: Skipping - CurrentPrice(${currentPrice.toFixed(2)}) <= TargetWholesale(${targetWholesalePrice?.toFixed(2) ?? 'N/A'})`);
    }
  }

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.First,
    discounts,
  };
};
