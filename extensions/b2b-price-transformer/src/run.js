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
    console.log("No priceListId found on company, skipping transformation.");
    return NO_CHANGES;
  }

  console.log(`Processing transformation | PriceList: ${priceListId} | BlanketPct: ${discountPct}%`);

  const operations = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // Current unit price in the cart (for B2B, this is usually the catalog price)
    const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const standardRetail = parseFloat(variant.standardRetail?.value ?? "0");

    let targetWholesalePrice = null;

    // ── 1. Check for Fixed Override ──────────────────────────────────────────
    const fixedPricesRaw = variant.metafield?.value;
    if (fixedPricesRaw) {
      try {
        const fixedPricesMap = JSON.parse(fixedPricesRaw);
        const fixedPrice = fixedPricesMap[priceListId];
        if (fixedPrice !== undefined && fixedPrice !== null) {
          targetWholesalePrice = parseFloat(fixedPrice);
          console.log(`Variant ${variant.id}: Found fixed override ${targetWholesalePrice}`);
        }
      } catch (e) {
        console.error(`Error parsing fixed prices for variant ${variant.id}:`, e);
      }
    }

    // ── 2. Fallback to Blanket Percentage ────────────────────────────────────
    // Only apply if the currentPrice is higher than what the blanket discount would be
    if (targetWholesalePrice === null && discountPct > 0) {
      // NOTE: We assume the 'currentPrice' is the base catalog price.
      // If the merchant hasn't removed the Shopify Admin adjustment yet, 
      // they might be double-discounted here. 
      // We take currentPrice as the baseline for the blanket % if standardRetail is missing.
      const baseline = (standardRetail > 0) ? standardRetail : currentPrice;
      targetWholesalePrice = baseline * (1 - discountPct / 100);
      console.log(`Variant ${variant.id}: Applied blanket pct -> ${targetWholesalePrice}`);
    }

    // ── 3. Apply Overrides for Strikethrough ──────────────────────────────────
    // If we have a target wholesale price and it's lower than retail, force the strikethrough.
    // Even if targetWholesalePrice is null, if standardRetail > currentPrice, we should 
    // force a strikethrough from Retail -> currentPrice.
    const finalPrice = targetWholesalePrice ?? currentPrice;
    const finalRetail = (standardRetail > finalPrice) ? standardRetail : null;

    if (finalRetail || targetWholesalePrice !== null) {
      console.log(`Line ${line.id}: Price=${finalPrice.toFixed(2)}, CompareAt=${(finalRetail ?? finalPrice).toFixed(2)}`);
      
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            amount: finalPrice.toFixed(2),
          },
          compareAtPrice: {
            amount: (finalRetail ?? finalPrice).toFixed(2),
          },
        },
      });
    }
  }

  console.log(`Total transformation operations: ${operations.length}`);
  return { operations };
};
