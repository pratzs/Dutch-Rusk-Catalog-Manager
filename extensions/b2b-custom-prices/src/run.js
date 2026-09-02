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

  const discounts = [];

  // Effective per-unit price actually paid after the wholesale discount
  // (or retail price if no wholesale discount applies to this line) --
  // BOGO Bundles below needs this to know how much a "free" unit is worth.
  const effectiveLines = [];

  if (priceListId) {
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

      let effectivePrice = currentPrice;

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

        effectivePrice = targetWholesalePrice;
      }

      effectiveLines.push({ id: line.id, quantity: line.quantity, variantId: variant.id, effectivePrice });
    }
  } else {
    // No B2B catalog on this company -- BOGO Bundles still needs line data,
    // just at plain retail (line.cost.amountPerQuantity) with no wholesale markdown.
    for (const line of input.cart.lines) {
      const variant = line.merchandise;
      if (variant.__typename !== "ProductVariant") continue;
      const currentPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
      effectiveLines.push({ id: line.id, quantity: line.quantity, variantId: variant.id, effectivePrice: currentPrice });
    }
  }

  // ── BOGO Bundles ──────────────────────────────────────────────────────────
  // Merged into this same function/discount because this shop's checkout only
  // ever executes one active Product Discount API function at a time --
  // a second, separately-registered discount function of the same API type
  // (tested extensively) never got invoked at checkout, regardless of
  // combinesWith settings. Config lives in the shop metafield
  // custom.bogo_bundles (JSON), edited via the app's BOGO Bundles page.
  const bogoRaw = input?.shop?.bogoBundles?.value;
  if (bogoRaw) {
    let bundles;
    try {
      bundles = JSON.parse(bogoRaw);
    } catch {
      bundles = [];
    }

    if (Array.isArray(bundles)) {
      for (const bundle of bundles) {
        const buyQty = Number(bundle?.buyQty);
        const getQty = Number(bundle?.getQty);
        const variantIds = Array.isArray(bundle?.variantIds) ? bundle.variantIds : [];
        if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0 || variantIds.length === 0) continue;

        const variantIdSet = new Set(variantIds);
        const matchingLines = effectiveLines.filter((line) => variantIdSet.has(line.variantId));
        if (matchingLines.length === 0) continue;

        const totalQty = matchingLines.reduce((sum, line) => sum + line.quantity, 0);
        const groups = Math.floor(totalQty / buyQty);
        if (groups <= 0) continue;

        let freeUnitsRemaining = Math.min(groups * getQty, totalQty);
        if (freeUnitsRemaining <= 0) continue;

        // Cheapest matching line first, so the free units come off the
        // lowest-value items -- matches Shopify's own BXGY convention.
        const sortedLines = [...matchingLines].sort((a, b) => a.effectivePrice - b.effectivePrice);

        for (const line of sortedLines) {
          if (freeUnitsRemaining <= 0) break;
          if (!line.effectivePrice || line.effectivePrice <= 0) continue;

          const freeFromThisLine = Math.min(freeUnitsRemaining, line.quantity);
          if (freeFromThisLine <= 0) continue;

          discounts.push({
            targets: [
              {
                cartLine: {
                  id: line.id,
                  quantity: freeFromThisLine,
                },
              },
            ],
            value: {
              fixedAmount: {
                amount: line.effectivePrice.toFixed(2),
                appliesToEachItem: true,
              },
            },
            message: bundle.label ?? "Buy X Get Y Free",
          });

          freeUnitsRemaining -= freeFromThisLine;
        }
      }
    }
  }

  if (!discounts.length) return EMPTY_DISCOUNT;

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.All,
    discounts,
  };
}
