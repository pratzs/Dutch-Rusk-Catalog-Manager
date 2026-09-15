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

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS WRITTEN THE WAY IT IS
//
// This Function has an 11M instruction budget. If it goes over, Shopify kills
// it, and because b2b-price-transformer has ALREADY raised every line to retail
// by then, the buyer is billed FULL RETAIL. That is what happened to #1409,
// #1850 and #1884. So instructions here are money.
//
// THE ONE THING WORTH KNOWING: every field in the input query is charged on
// EVERY cart line, whether or not the code reads it. Skipping only the read
// saves nothing -- that was measured, twice. The field has to leave the query.
//
// So this Function asks for three fields per line (id, quantity, catSavings)
// instead of the five it used to, and everything else it needs -- the retail
// price, the saving, and which deals the variant belongs to -- is folded into
// that one string by api.catalog-price-sync. Per-line cost fell from 0.125M to
// 0.076M, which is what took the cart limit from 80 lines to 115.
//
// Four other ideas were measured and rejected; they are listed in
// docs/B2B-PRICING.md so nobody spends time on them again.
//
// The money rules are NOT changed by any of this. tests/pricing.test.js pins
// them as final per-unit prices and must stay green.
// ─────────────────────────────────────────────────────────────────────────────

// Must be IDENTICAL to MAX_LINES_TO_TRANSFORM in b2b-price-transformer.
//
// This Function no longer receives the line cost, so it cannot tell for itself
// whether the transform raised a line. Both Functions instead read the same cart
// and apply the same limit to the same line count. Above the limit the transform
// raises nothing, so there is nothing to discount and emitting anything here
// would take a second discount off an already-correct catalog price.
const MAX_LINES_TO_TRANSFORM = 110;

// Above this many lines, deal allocation is skipped and only the catalog
// discount is worked out. Deals cost far more than the plain discount, and a
// cart this size has never had one apply.
const MAX_LINES_FOR_DEALS = 65;

/**
 * Format a non-negative integer number of cents as "12.34".
 *
 * Instead of Number.prototype.toFixed(2) purely for cost: double-to-fixed-point
 * formatting was a large part of the emit phase. Integer-to-string plus a concat
 * is far cheaper in QuickJS and gives the same string for every value this
 * Function can produce, since all money in is 2dp.
 *
 * @param {number} cents
 * @returns {string}
 */
function money(cents) {
  const minor = cents % 100;
  return (cents - minor) / 100 + (minor < 10 ? ".0" : ".") + minor;
}

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;

  // Not a B2B buyer on a catalog: nothing to do, and bail before touching lines.
  if (!priceListId) return EMPTY_DISCOUNT;

  const cartLines = input.cart.lines;
  const n = cartLines.length;

  // The transform stood down, so every line already sits at its correct catalog
  // price. Discounting again here would hand over a second discount.
  if (n > MAX_LINES_TO_TRANSFORM) return EMPTY_DISCOUNT;

  const plShort = priceListId.slice(priceListId.lastIndexOf("/") + 1);
  const needle = "|" + plShort + ":";

  // ── Fast path: too many lines for any deal to apply ───────────────────────
  //
  // Above MAX_LINES_FOR_DEALS nothing below this block can fire, so none of the
  // per-line bookkeeping it needs is worth paying for. Walking the cart once and
  // emitting straight out avoids allocating eight arrays the size of the cart
  // and costs about 3M fewer instructions on a 115-line cart, which is the
  // difference between fitting in the budget and being killed.
  //
  // This is the path every cart the guard was raised for actually takes.
  if (n > MAX_LINES_FOR_DEALS) {
    const wide = [];
    for (let i = 0; i < n; i++) {
      const cartLine = cartLines[i];
      const raw = cartLine.merchandise.catSavings?.value;
      if (!raw) continue;
      const at = raw.indexOf(needle);
      if (at < 0) continue;
      const off = parseFloat(raw.slice(at + needle.length, at + needle.length + 12));
      if (!(off > 0)) continue;
      wide.push({
        targets: [{ cartLine: { id: cartLine.id, quantity: cartLine.quantity } }],
        value: { fixedAmount: { amount: money(Math.round(off * 100)), appliesToEachItem: true } },
        message: "B2B Wholesale Price",
      });
    }
    if (!wide.length) return EMPTY_DISCOUNT;
    return { discountApplicationStrategy: DiscountApplicationStrategy.All, discounts: wide };
  }

  // Parallel arrays, one slot per cart line. Typed where the values are numeric
  // so QuickJS does not box every price and quantity.
  const lineIds = new Array(n);
  const qty = new Int32Array(n);
  const retail = new Float64Array(n);
  // Money is tracked in whole cents from here on. The deal override lands on an
  // exact half cent for some prices (13.85 at 10% is 1.385), and comparing
  // floats there rounded the opposite way to the old code on 3 of 440 real
  // orders. Integers cannot drift.
  const retailCents = new Int32Array(n);
  const savingCents = new Int32Array(n);
  const freeQty = new Int32Array(n);
  const dealQty = new Int32Array(n);
  // Saving on units a deal group consumes. 0 means full retail, which is what
  // deal-paid units get when the bundle has no override percentage.
  const dealSavingCents = new Int32Array(n);
  const dealTags = new Array(n);

  let count = 0;

  for (let i = 0; i < n; i++) {
    const cartLine = cartLines[i];
    const raw = cartLine.merchandise.catSavings?.value;
    // No value means this is not a ProductVariant, or the sync has not reached
    // it yet. Either way the transform did not raise it, so there is nothing to
    // take off and the line is simply skipped.
    if (!raw) continue;

    const at = raw.indexOf(needle);
    const off = at < 0 ? 0 : parseFloat(raw.slice(at + needle.length, at + needle.length + 12));
    const hasSaving = off > 0;

    // Deal membership. Reaching here means deals can apply.
    let tag = null;
    const d = raw.indexOf("|#");
    if (d >= 0) tag = raw.slice(d + 2, raw.indexOf("|", d + 2));

    // Only lines this buyer actually gets a discount on go any further, deals
    // included. That is the same protection the old per-line `transformRaised`
    // check gave: the transform raises exactly these lines, so a deal can only
    // ever compute off a raised price and never discount an already-correct one
    // a second time. Order #1913 lost about $38 that way.
    //
    // It also means a deal product the buyer's catalog does not discount gets no
    // deal. No deal variant is in that position today (checked: 0 of 75), and
    // erring this way can only ever under-apply a promotion, never overcharge.
    if (!hasSaving) continue;

    // Retail is the leading number; parseFloat stops at the "|".
    const rp = parseFloat(raw);
    if (!(rp > 0)) continue;

    const slot = count++;
    lineIds[slot] = cartLine.id;
    qty[slot] = cartLine.quantity;
    retail[slot] = rp;
    retailCents[slot] = Math.round(rp * 100);
    savingCents[slot] = Math.round(off * 100);
    dealTags[slot] = tag;
  }

  // ── BOGO Bundles ──────────────────────────────────────────────────────────
  //
  // ACTIVE -- the deals in custom.bogo_fn are live.
  //
  // Deal membership now travels on the variant itself, as ids inside
  // catalog_savings, because this Function no longer receives the variant id it
  // used to match on. api.catalog-price-sync writes those markers from the same
  // config the BOGO admin page writes, so editing a deal needs a sync to follow.
  //
  // Merged into this same discount because this shop's checkout only ever
  // executes one active Product Discount API function at a time.
  const bogoRaw = input?.discountNode?.bogoBundles?.value;
  if (bogoRaw && count > 0) {
    let bundles;
    try {
      bundles = JSON.parse(bogoRaw);
    } catch {
      bundles = [];
    }

    if (Array.isArray(bundles) && bundles.length > 0) {
      for (let b = 0; b < bundles.length; b++) {
        const bundle = bundles[b];
        const buyQty = Number(bundle?.b);
        const getQty = Number(bundle?.g);
        const dealId = bundle?.i;
        if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0 || !dealId) continue;

        // Optional catalog scoping: absent/empty list = every B2B customer.
        const catalogIds = Array.isArray(bundle?.c) ? bundle.c : [];
        if (catalogIds.length > 0 && !catalogIds.includes(plShort)) continue;

        const matches = [];
        let totalQty = 0;
        for (let i = 0; i < count; i++) {
          const tags = dealTags[i];
          if (tags === null || tags === undefined) continue;
          // Exact id match inside a comma list, without splitting (which would
          // allocate an array per line).
          const at = tags.indexOf(dealId);
          if (at < 0) continue;
          const before = at === 0 || tags.charCodeAt(at - 1) === 44;
          const afterAt = at + dealId.length;
          const after = afterAt === tags.length || tags.charCodeAt(afterAt) === 44;
          if (!before || !after) continue;
          matches.push(i);
          totalQty += qty[i];
        }
        if (matches.length === 0) continue;

        // "Buy N Get M Free" means N paid + M free = N+M per group, not N total.
        const groupSize = buyQty + getQty;
        const groups = Math.floor(totalQty / groupSize);
        if (groups <= 0) continue;

        // Optional per-deal override, only once the deal is actually active: it
        // sets the price of the PAID units inside the deal instead of leaving
        // them at full retail. It also applies to units beyond the deal groups,
        // but only ever as a REDUCTION -- a promotion must never leave a buyer
        // paying more than their catalog price on stock the deal did not consume.
        const overridePct = Number(bundle?.o);
        if (overridePct > 0 && overridePct < 100) {
          for (let j = 0; j < matches.length; j++) {
            const i = matches[j];
            const overrideOff = Math.round((retailCents[i] * overridePct) / 100);
            // Beyond-deal units: the deeper of the promo and the catalog saving.
            if (overrideOff > savingCents[i]) savingCents[i] = overrideOff;
            // Deal-paid units: the promo itself. Deliberately NOT floored at the
            // catalog saving -- pairing the catalog discount with a free unit is
            // the loss-making stack removed in 13ae4ca. A line can match more
            // than one bundle, so keep the cheapest (largest saving).
            if (overrideOff > dealSavingCents[i]) dealSavingCents[i] = overrideOff;
          }
        }

        // Units a deal group consumes don't get the normal catalog discount --
        // the free item IS the discount. Free units come off the cheapest
        // matching line first, matching Shopify's own BXGY convention.
        let freeRemaining = groups * getQty;
        let dealPaidRemaining = groups * buyQty;
        if (freeRemaining <= 0) continue;

        const order = matches.slice();
        // cheapest final price first, matching Shopify's own BXGY convention
        order.sort((x, y) => retailCents[x] - savingCents[x] - (retailCents[y] - savingCents[y]));

        for (let j = 0; j < order.length; j++) {
          const i = order[j];
          let available = qty[i] - freeQty[i] - dealQty[i];
          if (available <= 0) continue;

          const freeFromThisLine = Math.min(freeRemaining, available);
          freeQty[i] += freeFromThisLine;
          freeRemaining -= freeFromThisLine;
          available -= freeFromThisLine;

          const dealPaidFromThisLine = Math.min(dealPaidRemaining, available);
          dealQty[i] += dealPaidFromThisLine;
          dealPaidRemaining -= dealPaidFromThisLine;
        }
      }
    }
  }

  // ── Emit one discount entry per price tier on a line ───────────────────────
  // Checkout shows each as its own row (e.g. "5 @ retail, 1 @ $0 free,
  // 1 @ wholesale") instead of one blended per-unit average price.
  const discounts = [];

  for (let i = 0; i < count; i++) {
    const retailPrice = retail[i];
    const wholesaleOff = savingCents[i];
    const free = freeQty[i];
    const dealPaid = dealQty[i];
    const wholesaleQty = qty[i] - free - dealPaid;
    const id = lineIds[i];

    if (free > 0) {
      discounts.push({
        targets: [{ cartLine: { id, quantity: free } }],
        value: { fixedAmount: { amount: money(Math.round(retailPrice * 100)), appliesToEachItem: true } },
        message: "Buy X Get Y Free",
      });
    }

    // Two tiers, priced by different rules:
    //   deal-paid units   -> the bundle's override %, or full retail if none
    //   beyond-deal units -> the deeper of the catalog saving and the promo
    // They share a row only when both land on the same price.
    const dealPaidOff = dealSavingCents[i];

    // Equal to the cent is the same test the old code made with a half-cent
    // epsilon on prices, without the float.
    if (dealPaidOff === wholesaleOff) {
      const tierQty = dealPaid + wholesaleQty;
      if (tierQty > 0 && wholesaleOff > 0) {
        discounts.push({
          targets: [{ cartLine: { id, quantity: tierQty } }],
          value: { fixedAmount: { amount: money(wholesaleOff), appliesToEachItem: true } },
          message: "B2B Wholesale Price",
        });
      }
    } else {
      if (dealPaid > 0 && dealPaidOff > 0) {
        discounts.push({
          targets: [{ cartLine: { id, quantity: dealPaid } }],
          value: { fixedAmount: { amount: money(dealPaidOff), appliesToEachItem: true } },
          message: "Deal Price",
        });
      }
      if (wholesaleQty > 0 && wholesaleOff > 0) {
        discounts.push({
          targets: [{ cartLine: { id, quantity: wholesaleQty } }],
          value: { fixedAmount: { amount: money(wholesaleOff), appliesToEachItem: true } },
          message: "B2B Wholesale Price",
        });
      }
    }
  }

  if (!discounts.length) return EMPTY_DISCOUNT;

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.All,
    discounts,
  };
}
