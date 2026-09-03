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

        // Optional catalog scoping: if the deal lists specific catalogs
        // (by their price list GID), only apply it to customers on one of
        // those catalogs. Absent/empty list = applies to every B2B customer,
        // which keeps existing bundles working unchanged.
        const catalogIds = Array.isArray(bundle?.catalogIds) ? bundle.catalogIds : [];
        if (catalogIds.length > 0 && !catalogIds.includes(priceListId)) continue;

        const variantIdSet = new Set(variantIds);
        const matchingLines = lines.filter((line) => variantIdSet.has(line.variantId));
        if (matchingLines.length === 0) continue;

        // "Buy N Get M Free" means N paid + M free = N+M total needed per
        // group (e.g. Buy 5 Get 1 Free = the 6th unit is free), not N total.
        // Below this threshold the deal is inactive and normal catalog
        // pricing applies untouched -- no override, no free unit.
        const totalQty = matchingLines.reduce((sum, line) => sum + line.quantity, 0);
        const groupSize = buyQty + getQty;
        const groups = Math.floor(totalQty / groupSize);
        if (groups <= 0) continue;

        // Optional per-deal override, only takes effect once the deal is
        // actually active (checked above): replaces the customer's normal
        // catalog/wholesale % with a promo-specific one for this bundle's
        // products, applying to BOTH the paid portion of the deal (instead
        // of full retail) and any extra units beyond the deal (instead of
        // the normal catalog %) -- e.g. "10% off + Buy 5 Get 1 Free"
        // instead of full-retail-plus-free or the normal 20% catalog rate.
        // Leaving it blank keeps the original rule: paid units at full
        // retail, extra units at the normal catalog price.
        const overridePct = Number(bundle?.overridePct);
        const hasOverride = overridePct > 0 && overridePct < 100;
        if (hasOverride) {
          for (const line of matchingLines) {
            line.wholesalePrice = line.retailPrice * (1 - overridePct / 100);
            line.dealPaidUsesOverride = true;
          }
        }

        // The units a deal group consumes (both the paid and the free
        // portion) don't get the customer's normal catalog discount -- the
        // free item IS the discount. The paid portion goes back to full
        // retail ("normal price of Shopify") unless an override % above
        // says otherwise, since stacking the catalog discount with a free
        // unit would be a loss-making double discount. Only units beyond
        // what deal groups consume keep the normal (or overridden)
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
  // Checkout shows each as its own row (e.g. "5 @ retail, 1 @ $0 free,
  // 1 @ wholesale") instead of one blended per-unit average price -- this
  // works fine despite an earlier (mistaken) finding that a second entry on
  // the same line gets dropped; that was actually the discountNode bug.
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

    // Deal-paid units only get a discount when this bundle has an override %
    // (see above) -- otherwise they're full retail, no entry needed. When an
    // override IS active, deal-paid and beyond-the-deal units land on the
    // same overridden price, so they're combined into a single entry rather
    // than two identical-looking rows.
    const discountedQty = (line.dealPaidUsesOverride ? line.dealPaidQty : 0) + wholesaleQty;
    if (discountedQty > 0 && line.wholesalePrice < line.retailPrice - 0.001) {
      discounts.push({
        targets: [{ cartLine: { id: line.id, quantity: discountedQty } }],
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
