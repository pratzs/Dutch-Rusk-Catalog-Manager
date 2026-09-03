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

  // Per line: retailPrice (what the customer would pay with zero discounts),
  // wholesalePrice (after catalog pricing, or same as retail if none applies),
  // quantity, and variantId. Free units from BOGO Bundles are valued at
  // wholesalePrice. Exactly ONE discount entry is emitted per cart line at
  // the end -- Shopify's checkout appears to silently drop a second entry
  // that targets a cart line already targeted by an earlier entry from the
  // same function, even though discountApplicationStrategy is ALL and the
  // Shopify CLI's local function-run simulator doesn't catch this (it only
  // executes the code, it doesn't validate against checkout's own rules).
  const lines = [];

  for (const line of input.cart.lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;

    // currentPrice here is the price RAISED to Retail by the Transformer.
    const retailPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    let wholesalePrice = retailPrice;

    if (priceListId) {
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

      if (targetWholesalePrice !== null && retailPrice > targetWholesalePrice + 0.01) {
        wholesalePrice = targetWholesalePrice;
      }
    }

    lines.push({ id: line.id, quantity: line.quantity, variantId: variant.id, retailPrice, wholesalePrice, freeQty: 0, dealPaidQty: 0 });
  }

  // ── BOGO Bundles ──────────────────────────────────────────────────────────
  // Merged into this same function/discount because this shop's checkout only
  // ever executes one active Product Discount API function at a time --
  // a second, separately-registered discount function of the same API type
  // (tested extensively) never got invoked at checkout, regardless of
  // combinesWith settings. Config lives in the shop metafield
  // custom.bogo_bundles (JSON), edited via the app's BOGO Bundles page.
  const bogoRaw = input?.discountNode?.bogoBundles?.value;
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
        const matchingLines = lines.filter((line) => variantIdSet.has(line.variantId));
        if (matchingLines.length === 0) continue;

        // Optional per-deal override: replace the customer's normal
        // catalog/wholesale % with a promo-specific one for this bundle's
        // products, e.g. running "10% off" instead of the usual 20% at the
        // same time as "Buy 5 Get 1 Free". Only affects units outside the
        // deal groups (deal-paid units are always full retail regardless).
        const overridePct = Number(bundle?.overridePct);
        if (overridePct > 0 && overridePct < 100) {
          for (const line of matchingLines) {
            line.wholesalePrice = line.retailPrice * (1 - overridePct / 100);
          }
        }

        // "Buy N Get M Free" means N paid + M free = N+M total needed per
        // group (e.g. Buy 5 Get 1 Free = the 6th unit is free), not N total.
        const totalQty = matchingLines.reduce((sum, line) => sum + line.quantity, 0);
        const groupSize = buyQty + getQty;
        const groups = Math.floor(totalQty / groupSize);
        if (groups <= 0) continue;

        // The units a deal group consumes (both the paid and the free
        // portion) don't get the catalog/wholesale discount -- the free
        // item IS the discount. The paid portion goes back to full retail
        // ("normal price of Shopify"), otherwise the catalog discount and
        // the free unit would stack into a loss-making double discount.
        // Only units beyond what deal groups consume keep the normal
        // wholesale price. Free units still come off the cheapest matching
        // line(s) first, matching Shopify's own BXGY convention.
        let freeRemaining = groups * getQty;
        let dealPaidRemaining = groups * buyQty;
        if (freeRemaining <= 0) continue;

        const sortedLines = [...matchingLines].sort((a, b) => a.wholesalePrice - b.wholesalePrice);

        for (const line of sortedLines) {
          let available = line.quantity - line.freeQty - line.dealPaidQty;
          if (available <= 0) continue;

          const freeFromThisLine = Math.min(freeRemaining, available);
          line.freeQty += freeFromThisLine;
          freeRemaining -= freeFromThisLine;
          available -= freeFromThisLine;

          const dealPaidFromThisLine = Math.min(dealPaidRemaining, available);
          line.dealPaidQty += dealPaidFromThisLine;
          dealPaidRemaining -= dealPaidFromThisLine;
        }
      }
    }
  }

  // ── Emit one discount entry per price tier on a line ───────────────────────
  // DIAGNOSTIC: testing whether checkout can show separate quantities per
  // price tier (e.g. "5 @ retail, 1 @ $0, 1 @ wholesale") as distinct rows
  // instead of one blended per-unit average, now that the real discountNode
  // bug (not a duplicate-target issue) is fixed. The earlier "duplicate
  // target gets dropped" conclusion was reached while that bug was still
  // live, so it may have been a false conclusion -- re-testing here.
  const discounts = [];
  for (const line of lines) {
    const wholesaleQty = line.quantity - line.freeQty - line.dealPaidQty;

    if (line.freeQty > 0) {
      discounts.push({
        targets: [{ cartLine: { id: line.id, quantity: line.freeQty } }],
        value: { fixedAmount: { amount: line.retailPrice.toFixed(2), appliesToEachItem: true } },
        message: "Buy X Get Y Free",
      });
    }

    if (wholesaleQty > 0 && line.wholesalePrice < line.retailPrice - 0.001) {
      discounts.push({
        targets: [{ cartLine: { id: line.id, quantity: wholesaleQty } }],
        value: { fixedAmount: { amount: (line.retailPrice - line.wholesalePrice).toFixed(2), appliesToEachItem: true } },
        message: "B2B Wholesale Price",
      });
    }
  }

  if (!discounts.length) return EMPTY_DISCOUNT;

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.All,
    discounts,
  };
}
