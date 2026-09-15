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
// #1850 and #1884. So instructions here are money, and the line count this
// survives is the line count the transformer is allowed to raise.
//
// Measured per phase on an 80-line worst-case cart, against the 11M budget:
//
//                      before    after
//     receive input     4.14M    3.10M   smaller input query, smaller deal config
//     per-line loop     2.82M    1.82M   parallel typed arrays
//     BOGO allocation   3.49M      0     one pass over the cart, and skipped
//                                        entirely above MAX_LINES_FOR_DEALS
//     emit discounts    4.05M    3.90M   integer-cents formatting, not toFixed
//                      ------   ------
//                      14.50M   10.33M
//
// Of that remaining 3.90M, about 2.2M is Shopify serialising the output and is
// not ours to optimise -- which makes the NUMBER of discount rows a real
// constraint in its own right, not just the work done to compute them.
//
// Note what the "before" column says: the per-line JSON.parse of the old price
// map, long assumed to be the whole problem, was only ~12% of it. The cost was
// spread across all four phases, so all four had to be addressed.
//
// The money rules themselves are NOT changed by any of this. tests/pricing.test.js
// pins them as final per-unit prices and must stay green.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a non-negative integer number of cents as "12.34".
 *
 * This exists instead of Number.prototype.toFixed(2) purely for cost: emitting
 * the discount rows measured ~4.0M instructions on an 80-line cart, and
 * double-to-fixed-point formatting was a large part of it. Integer-to-string
 * plus a concat is far cheaper in QuickJS, and gives the same string for every
 * value this Function can produce: all money in is 2dp, so Math.round of the
 * cents lands on the same number toFixed would have rounded to. The per-unit
 * prices in tests/pricing.test.js pin that.
 *
 * @param {number} cents
 * @returns {string}
 */
function money(cents) {
  const minor = cents % 100;
  return (cents - minor) / 100 + (minor < 10 ? ".0" : ".") + minor;
}

// Above this many cart lines, deal allocation is skipped and only the catalog
// discount is worked out.
//
// This takes nothing away from anybody. Deals only ever apply to lines the cart
// transform raised, and the transform's own guard has always stood down below
// this size -- so a cart this big gets no deal today either, AND no discount
// rows. Skipping the deal maths is what pays for it to get the rows.
//
// Worst case, deals ON, against the 11M budget:
//
//     60 lines   9.60M   (12.8% headroom)
//     65 lines   9.96M   ( 9.5% headroom)  <-- set here
//     70 lines  10.44M   ( 5.1% headroom)
//     75 lines  11.05M   OVER, Function killed
//
// Deals therefore stop at 65 while the discount rows themselves continue to
// MAX_LINES_TO_TRANSFORM (75) in b2b-price-transformer.
const MAX_LINES_FOR_DEALS = 65;

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const company = input.cart.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;

  // Not a B2B buyer on a catalog: nothing to do, and bail before touching lines.
  if (!priceListId) return EMPTY_DISCOUNT;

  // Lookup key into the compact price string, built once per run.
  //
  // custom.catalog_prices_v2 looks like "|34326708537:12.34|34326872377:9.10|",
  // written by api.catalog-price-sync. It replaced a JSON map keyed by full
  // price list GIDs: same information, roughly half the bytes, and readable
  // with a native indexOf instead of a JSON.parse on every single cart line.
  //
  // (An earlier attempt at a hand-rolled scan was measured SLOWER than
  // JSON.parse because it indexed the string character by character, which
  // allocates in QuickJS. indexOf/slice are native and do not.)
  const plShort = priceListId.slice(priceListId.lastIndexOf("/") + 1);
  const needle = "|" + plShort + ":";

  const cartLines = input.cart.lines;
  const n = cartLines.length;

  // Parallel arrays, one slot per cart line. Typed where the values are
  // numeric so QuickJS does not box every price and quantity.
  const lineIds = new Array(n);
  const variantIds = new Array(n);
  const qty = new Int32Array(n);
  const retail = new Float64Array(n);
  const wholesale = new Float64Array(n);
  const freeQty = new Int32Array(n);
  const dealQty = new Int32Array(n);
  const dealPrice = new Float64Array(n); // NaN = no deal price on this line
  const raised = new Uint8Array(n);

  let count = 0;

  for (let i = 0; i < n; i++) {
    const cartLine = cartLines[i];
    // No __typename here on purpose. Asking for it cost ~0.4M instructions on
    // an 80-line cart -- every field in the input query is paid for on every
    // line, whether or not the code reads it (checked: skipping the READ saves
    // nothing, the field has to leave the QUERY). A line whose merchandise is
    // not a ProductVariant simply has no catPrices, so it finds no catalog
    // price and no discount is emitted for it, which is the same outcome the
    // old typename check produced.
    const variant = cartLine.merchandise;

    // This is the price AFTER the cart transform raised it, i.e. retail --
    // unless the transform stood down, in which case it is already the
    // catalog price and `raised` below comes out false.
    const retailPrice = parseFloat(cartLine.cost?.amountPerQuantity?.amount ?? "0");
    let wholesalePrice = retailPrice;

    // The buyer's catalog price for this variant. NaN when this catalog has no
    // special rate for it, which is also how "absent from the string" reads.
    let catalogPrice = NaN;

    const raw = variant.catPrices?.value;
    if (raw) {
      const at = raw.indexOf(needle);
      if (at >= 0) {
        const from = at + needle.length;
        // Bounded so a long string never allocates a long tail; parseFloat
        // stops at the closing delimiter by itself.
        catalogPrice = parseFloat(raw.slice(from, from + 12));
      }
    }

    const haveCatalogPrice = catalogPrice === catalogPrice; // false only for NaN
    if (haveCatalogPrice && retailPrice > catalogPrice + 0.01) {
      wholesalePrice = catalogPrice;
    }

    // Did the cart transform actually raise this line to retail?
    //
    // It stands down above its own line guard, and when it does the line
    // arrives already at the catalog price. Every BOGO calculation below is a
    // percentage OFF this price, so on a stood-down cart a deal would discount
    // the catalog price a second time and hand over a free unit on top. That is
    // real margin: order #1913 (48 lines, Night n Day) took a further 10% off
    // eight Dragon bags that were already at the Night n Day rate.
    //
    // When no catalog price is known the transform would not have raised the
    // line either, so the price in hand is the plain one and a deal off it is
    // legitimate -- hence the default of true.
    const slot = count++;
    lineIds[slot] = cartLine.id;
    variantIds[slot] = variant.id;
    qty[slot] = cartLine.quantity;
    retail[slot] = retailPrice;
    wholesale[slot] = wholesalePrice;
    dealPrice[slot] = NaN;
    raised[slot] = !haveCatalogPrice || retailPrice > catalogPrice + 0.011 ? 1 : 0;
  }

  // ── BOGO Bundles ──────────────────────────────────────────────────────────
  //
  // ACTIVE -- the deals in custom.bogo_bundles are live.
  //
  // Note the dependency: this deal logic assumes deal-paid units can sit at
  // full retail while the free unit IS the discount. That only holds while the
  // b2b-price-transformer cart transform is registered and raising lines. If
  // that Function is ever removed again, nothing can raise a line and the best
  // this can do is catalog price PLUS a free unit -- the loss-making stack
  // removed in 13ae4ca. The two must be enabled or disabled together.
  //
  // Merged into this same function/discount because this shop's checkout only
  // ever executes one active Product Discount API function at a time --
  // a second, separately-registered discount function of the same API type
  // (tested extensively) never got invoked at checkout, regardless of
  // combinesWith settings. Config lives on the DISCOUNT NODE metafield
  // custom.bogo_bundles (JSON), edited via the app's BOGO Bundles page.
  const bogoRaw = input?.discountNode?.bogoBundles?.value;
  if (bogoRaw && count > 0 && count <= MAX_LINES_FOR_DEALS) {
    let bundles;
    try {
      bundles = JSON.parse(bogoRaw);
    } catch {
      bundles = [];
    }

    if (Array.isArray(bundles) && bundles.length > 0) {
      // Keep only the bundles that could apply to this buyer at all, so the
      // per-cart work below is proportional to the deals actually live for
      // them rather than to everything configured.
      const active = [];

      for (let b = 0; b < bundles.length; b++) {
        const bundle = bundles[b];
        const buyQty = Number(bundle?.b);
        const getQty = Number(bundle?.g);
        const bundleVariantIds = Array.isArray(bundle?.v) ? bundle.v : [];
        if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0 || bundleVariantIds.length === 0) continue;

        // Optional catalog scoping: if the deal lists specific catalogs, only
        // apply it to customers on one of those. Absent/empty list = applies to
        // every B2B customer, which keeps existing bundles working unchanged.
        const catalogIds = Array.isArray(bundle?.c) ? bundle.c : [];
        if (catalogIds.length > 0 && !catalogIds.includes(plShort)) continue;

        active.push({ bundle, buyQty, getQty, variantIds: bundleVariantIds, matches: [], totalQty: 0 });
      }

      if (active.length > 0) {
        // One index over every deal variant, so the cart is walked ONCE rather
        // than once per bundle. Matching used to be O(lines x bundles) of Set
        // lookups and measured 3.5M instructions on an 80-line cart.
        //
        // A variant can appear in more than one deal, so a slot holds either a
        // single bundle index or an array of them.
        const owner = new Map();
        for (let a = 0; a < active.length; a++) {
          const ids = active[a].variantIds;
          for (let k = 0; k < ids.length; k++) {
            const seen = owner.get(ids[k]);
            if (seen === undefined) owner.set(ids[k], a);
            else if (typeof seen === "number") owner.set(ids[k], [seen, a]);
            else seen.push(a);
          }
        }

        // Only lines the transform actually raised. On a cart big enough that
        // the transform stood down, every line is already at its catalog price
        // and a deal here would discount it twice -- see `raised` above.
        //
        // Safe to collect up front, before any bundle runs: neither what a
        // bundle matches nor the quantity on a line is changed by an earlier
        // bundle, only prices are.
        for (let i = 0; i < count; i++) {
          if (!raised[i]) continue;
          // The config carries bare numeric ids; cart lines carry full gids.
          // Sliced here rather than in the main loop so a cart with no live
          // deals never pays for it.
          const gid = variantIds[i];
          const hit = owner.get(gid.slice(gid.lastIndexOf("/") + 1));
          if (hit === undefined) continue;
          if (typeof hit === "number") {
            active[hit].matches.push(i);
            active[hit].totalQty += qty[i];
          } else {
            for (let h = 0; h < hit.length; h++) {
              active[hit[h]].matches.push(i);
              active[hit[h]].totalQty += qty[i];
            }
          }
        }

        for (let a = 0; a < active.length; a++) {
          const bundle = active[a].bundle;
          const buyQty = active[a].buyQty;
          const getQty = active[a].getQty;
          const matches = active[a].matches;
          if (matches.length === 0) continue;

          // "Buy N Get M Free" means N paid + M free = N+M total needed per
          // group (e.g. Buy 5 Get 1 Free = the 6th unit is free), not N total.
          // Below this threshold the deal is inactive and normal catalog
          // pricing applies untouched -- no override, no free unit.
          const groupSize = buyQty + getQty;
          const groups = Math.floor(active[a].totalQty / groupSize);
          if (groups <= 0) continue;

          // Optional per-deal override, only takes effect once the deal is
          // actually active (checked above): it sets the price of the PAID
          // units inside the deal, instead of those units falling back to full
          // retail -- e.g. "10% off + Buy 5 Get 1 Free" rather than
          // full-retail-plus-free. Leaving it blank keeps the original rule of
          // deal-paid units at full retail.
          //
          // The promo rate also applies to units beyond the deal groups, as
          // configured -- but only ever as a REDUCTION. If the customer's own
          // catalog rate is already deeper than the promo, they keep it. A
          // promotion must never leave a customer paying more than their
          // catalog price on stock the deal didn't consume; before this floor,
          // catalogs priced below the override (Night 'n Day, Metromart) were
          // charged the dearer promo rate on those units.
          const overridePct = Number(bundle?.o);
          if (overridePct > 0 && overridePct < 100) {
            const factor = 1 - overridePct / 100;
            for (let j = 0; j < matches.length; j++) {
              const i = matches[j];
              const overridePrice = retail[i] * factor;
              // Beyond-deal units: promo rate, floored at the catalog price.
              if (overridePrice < wholesale[i]) wholesale[i] = overridePrice;
              // Deal-paid units: the promo rate itself. Deliberately NOT floored
              // at catalog -- pairing the catalog discount with a free unit is
              // the loss-making stack removed in 13ae4ca. A line can match more
              // than one bundle, so keep the cheapest for a stable outcome.
              // The NaN on an untouched line makes this comparison false, which
              // is the "not set yet" case.
              if (!(dealPrice[i] <= overridePrice)) dealPrice[i] = overridePrice;
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

          // Cheapest first. Sorted here rather than at match time because the
          // override above can have just changed these prices.
          const order = matches.slice();
          order.sort((x, y) => wholesale[x] - wholesale[y]);

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
  }

  // ── Emit one discount entry per price tier on a line ───────────────────────
  // Checkout shows each as its own row (e.g. "5 @ retail, 1 @ $0 free,
  // 1 @ wholesale") instead of one blended per-unit average price.
  const discounts = [];

  for (let i = 0; i < count; i++) {
    const retailPrice = retail[i];
    const wholesalePrice = wholesale[i];
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

    // Two separate tiers, because they are priced by different rules:
    //   - deal-paid units   -> the bundle's override %, or full retail if none
    //   - beyond-deal units -> the better of the catalog price and the promo
    // They only share a row when both land on the same price, which keeps
    // checkout from showing two identical-looking lines.
    const dealPaidPrice = dealPrice[i] === dealPrice[i] ? dealPrice[i] : retailPrice;

    if (Math.abs(dealPaidPrice - wholesalePrice) < 0.005) {
      const tierQty = dealPaid + wholesaleQty;
      if (tierQty > 0 && wholesalePrice < retailPrice - 0.001) {
        discounts.push({
          targets: [{ cartLine: { id, quantity: tierQty } }],
          value: {
            fixedAmount: {
              amount: money(Math.round((retailPrice - wholesalePrice) * 100)),
              appliesToEachItem: true,
            },
          },
          message: "B2B Wholesale Price",
        });
      }
    } else {
      if (dealPaid > 0 && dealPaidPrice < retailPrice - 0.001) {
        discounts.push({
          targets: [{ cartLine: { id, quantity: dealPaid } }],
          value: {
            fixedAmount: {
              amount: money(Math.round((retailPrice - dealPaidPrice) * 100)),
              appliesToEachItem: true,
            },
          },
          message: "Deal Price",
        });
      }
      if (wholesaleQty > 0 && wholesalePrice < retailPrice - 0.001) {
        discounts.push({
          targets: [{ cartLine: { id, quantity: wholesaleQty } }],
          value: {
            fixedAmount: {
              amount: money(Math.round((retailPrice - wholesalePrice) * 100)),
              appliesToEachItem: true,
            },
          },
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
