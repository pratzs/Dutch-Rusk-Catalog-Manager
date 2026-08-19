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

  const discounts = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // currentPrice here is the price RAISED to Retail by the Transformer.
    const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // ── 1. PRIMARY: Explicit Fixed Price from Sync Map ─────────────────────
    const fixedPricesRaw = variant.fixedPrices?.value;
    if (fixedPricesRaw) {
      try {
        const fixedPricesMap = JSON.parse(fixedPricesRaw);
        const fixedPrice = fixedPricesMap[priceListId];
        if (fixedPrice !== undefined && fixedPrice !== null) {
          targetWholesalePrice = parseFloat(fixedPrice);
        }
      } catch (e) {
        // malformed fixedPrices JSON — fall through to secondary calculation
      }
    }

    // ── 2. SECONDARY: Independent Calculation (Flicker Protection) ────────
    // If the sync map hasn't loaded yet but we have a raised retail price,
    // we use the Company's blanket discount percentage to calculate the target.
    if (targetWholesalePrice === null && discountPct > 0 && standardRetail > 0) {
      targetWholesalePrice = standardRetail * (1 - discountPct / 100);
    }

    // APPLY DISCOUNT: calculate the markdown from currentPrice (Retail) to Target Wholesale.
    if (targetWholesalePrice !== null && currentPrice > targetWholesalePrice + 0.01) {
      const discountAmount = currentPrice - targetWholesalePrice;

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
}
