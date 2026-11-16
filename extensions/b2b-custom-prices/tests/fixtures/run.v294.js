// The discount Function exactly as released in app version 294 (16 Nov 2026):
// shared entries and the big-cart budget, but no deals above 65 lines.
// @ts-check
import { DiscountApplicationStrategy } from "../../generated/api";

/**
 * @typedef {import("../../generated/api").RunInput} RunInput
 * @typedef {import("../../generated/api").FunctionRunResult} FunctionRunResult
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

// ── The shared budget for big carts (above WIDE_FROM lines) ──────────────────
//
// THESE CONSTANTS AND THE WALK THAT USES THEM MUST BE IDENTICAL IN
// b2b-price-transformer/src/run.js AND b2b-custom-prices/src/run.js.
//
// Until 16 Nov 2026 both Functions simply stood down above 108 lines. Night n Day
// stores then started sending 119-126 line carts (#3041, #3283, #3285, #3331),
// which came through at the right price but with no discount rows at all.
//
// A fixed line count was the wrong measure. What a big cart costs is mostly the
// OUTPUT: about 0.046M instructions for every discount entry, against 0.027M for
// one more line sharing an entry that already exists. Real carts repeat the same
// saving on many lines (#3331: 126 lines, 51 different savings), so the discount
// Function now puts every line with the same saving under ONE entry, and the
// limit is a budget in thousands of instructions rather than a line count.
//
// Both Functions walk the cart in the same order and add up what the pair would
// spend. A line is raised (and discounted) only while both totals stay inside
// BUDGET. The first line that would not fit ends it: that line and every line
// after it keep Shopify's native catalog price, which is correct, they just have
// no discount row. So an enormous cart degrades to "most lines have rows"
// rather than "none do", and neither Function can be killed for cost.
//
// The walk depends only on the line count and each line's catalog_savings
// string, which both Functions receive, so they always agree on which lines are
// in. Coefficients are measured with `shopify app function run`, rounded UP.
// Re-measure before changing any of them (docs/B2B-PRICING.md).
const WIDE_FROM = 65; // same number as MAX_LINES_FOR_DEALS
const BUDGET = 10600; // thousands of instructions; the platform limit is 11,000
const D_FIXED = 400; // discount Function: fixed cost
const D_PER_LINE = 26; //   every cart line, covered or not (receive + loop)
const D_PER_TARGET = 27; //   every covered line
const D_PER_ENTRY = 46; //   every DIFFERENT saving among covered lines
const D_TIER_RESERVE = 460; //   volume breaks can split up to 10 lines into their own entries
const T_FIXED = 250; // cart transform: fixed cost
const T_PER_LINE = 26; //   every cart line, covered or not
const T_PER_OP = 52; //   every covered line
// Past this many lines nothing has been measured, so both stand down as before.
const MAX_LINES_TO_TRANSFORM = 250;

// Above this many lines, deal allocation is skipped and only the catalog
// discount is worked out. Deals cost far more than the plain discount, and a
// cart this size has never had one apply.
const MAX_LINES_FOR_DEALS = 65;

// Volume pricing is worked out for a limited number of lines per cart, in cart
// order, because each flagged line costs about 25-30k instructions and the budget
// is tight on big carts. The allowance shrinks as the cart grows, sized from
// measurements of a cart where EVERY line has breaks (docs/B2B-PRICING.md).
// Lines past the allowance pay their normal catalog price: never more than the
// buyer's catalog price, whereas running out of budget bills full retail.
function tiersAllowed(lineCount) {
  return lineCount <= 40 ? 40 : lineCount <= MAX_LINES_FOR_DEALS ? 25 : 10;
}

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
 * Volume pricing. A variant with quantity price breaks has a catalog_savings
 * string that STARTS WITH "+", and each break rides inside its price list's entry
 * as an "@<min qty>=<saving>" pair right after the base saving:
 *
 *     +27.75|34505457977:5.25@12=9.10@24=11.50|
 *     ^flag             ^base   ^12+    ^24+     (all savings off retail)
 *
 * An older Function (or any parseFloat) reads "+27.75" as 27.75 and stops at the
 * "@" in the saving, so it prices exactly as before: the data can ship before
 * this code.
 *
 * COST MATTERS HERE. Every instruction is money (see the header of this file),
 * and string operations in QuickJS are expensive, roughly 2k instructions each.
 * A first version that looked for "@" in every line cost +0.7M on a 110-line cart
 * with NO breaks at all. So:
 *   - a plain line pays one character read (the "+" flag) and nothing else;
 *   - only a flagged line calls this, and it works on a 96-character window;
 *   - a cart honours breaks on a limited number of lines (tiersAllowed below).
 *
 * Returns the saving that applies at `qty`: the deepest qualifying break, never
 * less than `base`.
 *
 * @param {string} raw
 * @param {number} from index just after "|<priceListId>:"
 * @param {number} qty
 * @param {number} base
 * @returns {number}
 */
function tierSaving(raw, from, qty, base) {
  const tail = raw.slice(from, from + 96);
  const end = tail.indexOf("|");
  const parts = (end < 0 ? tail : tail.slice(0, end)).split("@");
  let best = base;
  for (let k = 1; k < parts.length; k++) {
    const p = parts[k];
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const minQty = parseInt(p.slice(0, eq), 10);
    const val = parseFloat(p.slice(eq + 1));
    if (minQty > 0 && qty >= minQty && val > best) best = val;
  }
  return best;
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
  let tiersLeft = tiersAllowed(n);
  if (n > MAX_LINES_FOR_DEALS) {
    const wide = [];
    // One entry per DIFFERENT saving, each carrying every line that gets it.
    // Integer keys on a plain object: a Map keyed by string was measured in
    // September and cost more than it saved.
    const byCents = {};
    // The budget walk. The same walk as in b2b-price-transformer: same lines
    // counted, same order, same sums, so both stop at the same line. byCents
    // doubles as the record of which savings have been seen, keyed by the BASE
    // saving exactly as the transform keys it (the transform has no quantity,
    // so it cannot know about volume breaks).
    let dCost = D_FIXED + D_TIER_RESERVE + D_PER_LINE * n;
    let room = Math.floor((BUDGET - T_FIXED - T_PER_LINE * n) / T_PER_OP);
    for (let i = 0; i < n; i++) {
      const cartLine = cartLines[i];
      const raw = cartLine.merchandise.catSavings?.value;
      if (!raw) continue;
      const at = raw.indexOf(needle);
      if (at < 0) continue;
      const from = at + needle.length;
      const base = parseFloat(raw.slice(from, from + 12));
      if (!(base > 0)) continue;

      // Same rounding expression and same "counts as new" rule as the transform.
      const cents = (base * 100 + 0.5) | 0;
      let entry = byCents[cents];
      dCost += entry === undefined || cents > 65535 ? D_PER_TARGET + D_PER_ENTRY : D_PER_TARGET;
      // The transform stopped raising here, so everything from this line on is
      // already at its catalog price.
      if (dCost > BUDGET || --room < 0) break;
      if (entry === undefined) {
        entry = {
          targets: [],
          value: { fixedAmount: { amount: money(cents), appliesToEachItem: true } },
          message: "B2B Wholesale Price",
        };
        byCents[cents] = entry;
      }

      // Volume pricing: a line that reaches a break gets a row of its own at
      // the deeper saving. D_TIER_RESERVE pays for up to ten of these.
      if (tiersLeft > 0 && raw[0] === "+") {
        tiersLeft--;
        const deep = Math.round(tierSaving(raw, from, cartLine.quantity, base) * 100);
        if (deep !== cents) {
          wide.push({
            targets: [{ cartLine: { id: cartLine.id } }],
            value: { fixedAmount: { amount: money(deep), appliesToEachItem: true } },
            message: "B2B Wholesale Price",
          });
          continue;
        }
      }
      // No quantity on the target: null means the whole line, and output bytes
      // are the most expensive thing this Function produces.
      if (entry.targets.length === 0) wide.push(entry);
      entry.targets.push({ cartLine: { id: cartLine.id } });
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
    let off = at < 0 ? 0 : parseFloat(raw.slice(at + needle.length, at + needle.length + 12));
    const hasSaving = off > 0;
    // Volume pricing: a deeper saving once the line reaches a break's quantity.
    if (hasSaving && tiersLeft > 0 && raw[0] === "+") {
      tiersLeft--;
      off = tierSaving(raw, at + needle.length, cartLine.quantity, off);
    }

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
