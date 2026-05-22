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
    console.log("[transformer] No priceListId found on company, skipping.");
    return NO_CHANGES;
  }

  console.log(`[transformer] Run for List: ${priceListId} | Blanket: ${discountPct}%`);

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
          console.log(`[transformer] Line ${line.id}: Found fixed override ${targetWholesalePrice}`);
        }
      } catch (e) {
        console.error(`[transformer] JSON Error for variant ${variant.id}:`, e);
      }
    }

    // 2. Fallback to Blanket Percentage
    if (targetWholesalePrice === null && discountPct > 0) {
      const baseline = (standardRetail > 0) ? standardRetail : currentPrice;
      targetWholesalePrice = baseline * (1 - discountPct / 100);
      console.log(`[transformer] Line ${line.id}: Applied blanket pct -> ${targetWholesalePrice}`);
    }

    const finalWholesale = targetWholesalePrice ?? currentPrice;
    const finalRetail = (standardRetail > finalWholesale) ? standardRetail : 0;

    // STRATEGY: We RAISE the price to the Retail baseline ($31.30).
    // The Discount function will then apply the markdown to reach finalWholesale ($25.04).
    if (finalRetail > finalWholesale) {
      console.log(`[transformer] Line ${line.id}: Raising Price ${currentPrice.toFixed(2)} -> ${finalRetail.toFixed(2)} (WholesaleTarget=${finalWholesale.toFixed(2)})`);
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: finalRetail.toFixed(2),
              }
            }
          }
        },
      });
    } else {
      console.log(`[transformer] Line ${line.id}: No raise needed. Retail(${finalRetail.toFixed(2)}) <= WholesaleTarget(${finalWholesale.toFixed(2)})`);
    }
  }

  console.log(`[transformer] Total operations: ${operations.length}`);
  return { operations };
};
