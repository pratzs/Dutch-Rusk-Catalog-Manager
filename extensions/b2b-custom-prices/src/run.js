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

// Up to this many lines every line goes through the deal and volume-break
// logic one by one. Above it, lines share entries by saving, and deals are a
// second step that runs only when the budget has room left (below).
const MAX_LINES_FOR_DEALS = 65;

// ── Deals and extra volume breaks on big carts: only out of SPARE budget ─────
//
// Until 16 Nov 2026 a cart above 65 lines never got a Buy X Get Y deal, and
// volume breaks on only ten lines. #3304 (102 lines) and #2980 (68) each missed
// a free unit that way, #2246 (70 lines) six.
//
// The transform cannot tell whether a deal will fire: it never sees quantities.
// So the budget walk is NOT allowed to depend on deals. Every covered line is
// counted as a plain line, exactly as the transform counts it (the walk and its
// constants are unchanged from version 294), which guarantees each one at least
// its "B2B Wholesale Price" row. Lines on a deal (and break
// lines past the ten-line allowance) are set aside during the walk. When the
// walk is over this Function knows what is left of BUDGET, and it runs the deal
// logic on the set-aside lines only if that is enough to pay for all of them.
// If it is not, they get their plain wholesale row, which is what every big
// cart got before. So this can add a deal; it can never take a row away, and
// it cannot push the Function over its limit.
//
// What the deal logic costs on top of the plain rows already paid for, in
// thousands of instructions. Measured worst case, rounded up:
const D_DEFER_FIXED = 700; //   looking for deal markers, setting lines aside, the arrays, the deal list
const D_DEFER_LINE = 66; //   every set-aside line
const D_DEFER_FLAG = 45; //   more if it has volume breaks
const D_DEFER_MEMBER = 21; //   every deal a set-aside line is on (a line can be on several)
const D_DEFER_SCAN = 4; //   every configured deal looks at every set-aside line
// Looking for deal markers and setting lines aside is itself work the budget
// walk does not count (it cannot: the transform does not do it). It is bounded
// instead, so it always fits in the gap between BUDGET and the platform limit:
//   - above this many cart lines deals are not attempted at all. A cart that
//     size has no room left for them anyway, and it then pays nothing extra;
const DEALS_MAX_LINES = 130;
//   - at most this many lines are set aside. One more and nothing further is:
//     if deals were on, they stand down for the cart and the set-aside lines get
//     their plain row at once (a deal is all or nothing); if only break lines
//     were set aside, those keep their place and the rest get plain rows.
const MAX_DEFERRED = 36;

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
 * Big carts: put `units` of a line under the entry for this saving and message,
 * creating the entry the first time. Output bytes are the dearest thing this
 * Function makes, and one entry carrying many lines is far smaller than one
 * entry per line. The quantity is left off when the row covers the whole line
 * (null means "all of it").
 *
 * @param {Array} discounts
 * @param {Record<number, any>} map   entries for ONE message, by saving in cents
 * @param {number} cents
 * @param {string} message
 * @param {string} id        cart line id
 * @param {number} units     units of the line this row covers
 * @param {number} lineQty   the line's full quantity
 */
function shareRow(discounts, map, cents, message, id, units, lineQty) {
  let entry = map[cents];
  if (entry === undefined) {
    entry = {
      targets: [],
      value: { fixedAmount: { amount: money(cents), appliesToEachItem: true } },
      message,
    };
    map[cents] = entry;
  }
  if (entry.targets.length === 0) discounts.push(entry);
  entry.targets.push(units === lineQty ? { cartLine: { id } } : { cartLine: { id, quantity: units } });
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

  // Parallel arrays, one slot per line that goes through the deal and
  // volume-break logic: every discounted line of a small cart, only the
  // set-aside lines of a big one. Typed where the values are numeric so QuickJS
  // does not box every price and quantity.
  //
  // A big cart makes them only if it sets lines aside AND can afford the deal
  // logic: creating nine arrays costs about 0.7M instructions, which a big cart
  // with no deal lines has no reason to pay.
  const big = n > MAX_LINES_FOR_DEALS;
  let size = big ? 0 : n;
  let lineIds = new Array(size);
  let qty = new Int32Array(size);
  let retail = new Float64Array(size);
  // Money is tracked in whole cents from here on. The deal override lands on an
  // exact half cent for some prices (13.85 at 10% is 1.385), and comparing
  // floats there rounded the opposite way to the old code on 3 of 440 real
  // orders. Integers cannot drift.
  let retailCents = new Int32Array(size);
  let savingCents = new Int32Array(size);
  let freeQty = new Int32Array(size);
  let dealQty = new Int32Array(size);
  // Saving on units a deal group consumes. 0 means full retail, which is what
  // deal-paid units get when the bundle has no override percentage.
  let dealSavingCents = new Int32Array(size);
  let dealTags = new Array(size);

  let count = 0;

  // Every discount entry this run produces. On a big cart the shared entries
  // go in first; the rows of the lines in the arrays above follow.
  const discounts = [];

  const bogoRaw = input?.discountNode?.bogoBundles?.value;
  // Parsed at most once: by the big-cart block when it has to price the deal
  // logic, otherwise by the deal block itself.
  let bundles = null;
  // Big carts only: the shared "B2B Wholesale Price" entries, by saving in cents.
  let byCents = null;

  let tiersLeft = tiersAllowed(n);
  if (big) {
    // ── Big cart ─────────────────────────────────────────────────────────────
    // One entry per DIFFERENT saving, each carrying every line that gets it.
    // Integer keys on a plain object: a Map keyed by string was measured in
    // September and cost more than it saved.
    byCents = {};
    // The budget walk. The same walk as in b2b-price-transformer: same lines
    // counted, same order, same sums, so both stop at the same line. byCents
    // doubles as the record of which savings have been seen, keyed by the BASE
    // saving exactly as the transform keys it (the transform has no quantity,
    // so it cannot know about volume breaks or deals).
    let dCost = D_FIXED + D_TIER_RESERVE + D_PER_LINE * n;
    let room = Math.floor((BUDGET - T_FIXED - T_PER_LINE * n) / T_PER_OP);
    // Does any deal apply to this buyer at all? Read off the raw text rather
    // than parsed: on a big cart the parse is not free, and most big carts
    // belong to a catalog no deal is scoped to (on 16 Nov 2026 every deal was
    // General Catalog only, every 100+ line cart Night n Day). The writer
    // (forFunction in app/lib/bogo-schedule.server.js) leaves "c" out when a
    // deal is for every catalog, so a deal applies here if it names this
    // catalog, or if some deal names none. Getting this wrong can only cost
    // instructions or leave a big cart without its deal, as before; the deal
    // logic itself still checks each deal's catalogs properly.
    let dealsOn = false;
    let nb = 0; // how many deals are configured
    if (n <= DEALS_MAX_LINES && bogoRaw && bogoRaw.length > 2) {
      let scoped = 0;
      for (let k = bogoRaw.indexOf('"i":'); k >= 0; k = bogoRaw.indexOf('"i":', k + 4)) nb++;
      for (let k = bogoRaw.indexOf('"c":'); k >= 0; k = bogoRaw.indexOf('"c":', k + 4)) scoped++;
      dealsOn = scoped < nb || bogoRaw.indexOf('"' + plShort + '"') >= 0;
    }
    // Covered lines set aside for the deal logic: the cart line, its string
    // (kept, because reading it out of the Function input again is not free),
    // where its saving starts in that string, and its base saving. Plain
    // arrays, made only when the first such line turns up.
    let asideOn = true;
    let dLine = null;
    let dRaw = null;
    let dFrom = null;
    let dCents = null;
    let dn = 0;
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

      const flagged = raw.charCodeAt(0) === 43;
      // Is this line on a deal? Searching the string costs 7-12k instructions a
      // line, reading one character under 1k, so: a string with no deal marker
      // ends in a 2dp saving ("...:4.00|"), which puts a "." four characters
      // from the end. A deal marker ("...|#dragon-2kg-5-1|") does not. A deal id
      // that happened to have a "." there would only mean that line gets its
      // plain wholesale row, as every big cart did before.
      if (asideOn && ((dealsOn && raw.charCodeAt(raw.length - 4) !== 46) || (flagged && tiersLeft <= 0))) {
        if (dn < MAX_DEFERRED) {
          if (dLine === null) {
            dLine = [];
            dRaw = [];
            dFrom = [];
            dCents = [];
          }
          dLine.push(cartLine);
          dRaw.push(raw);
          dFrom.push(from);
          dCents.push(cents);
          dn++;
          continue;
        }
        // One more than the deal logic may take. Nothing more is set aside.
        asideOn = false;
        if (dealsOn) {
          // A deal is all or nothing: counting it over only some of its lines
          // would hand out fewer free units than the cart has earned. So every
          // line already set aside gets its plain row now, as before.
          dealsOn = false;
          for (let j = 0; j < dn; j++) {
            const e = byCents[dCents[j]];
            if (e.targets.length === 0) discounts.push(e);
            e.targets.push({ cartLine: { id: dLine[j].id } });
          }
          dn = 0;
          dLine = null;
        }
        // Break lines only: each is priced on its own, so the ones already set
        // aside keep their place, and this one falls through to its plain row.
      }

      // Volume pricing: a line that reaches a break gets a row of its own at
      // the deeper saving. D_TIER_RESERVE pays for up to ten of these.
      if (flagged && tiersLeft > 0) {
        tiersLeft--;
        const deep = Math.round(tierSaving(raw, from, cartLine.quantity, base) * 100);
        if (deep !== cents) {
          discounts.push({
            targets: [{ cartLine: { id: cartLine.id } }],
            value: { fixedAmount: { amount: money(deep), appliesToEachItem: true } },
            message: "B2B Wholesale Price",
          });
          continue;
        }
      }
      // No quantity on the target: null means the whole line, and output bytes
      // are the most expensive thing this Function produces.
      if (entry.targets.length === 0) discounts.push(entry);
      entry.targets.push({ cartLine: { id: cartLine.id } });
    }

    if (dn > 0) {
      // Is there room left to run the deal logic on every set-aside line?
      const spare = BUDGET - dCost;
      let tags = null;
      let affordable = false;
      // First a floor: every line on one deal. Only if that fits is it worth
      // parsing the deal list and reading the markers, and then their cost is
      // inside D_DEFER_FIXED and `spare` already. When deals were switched off
      // (none for this catalog, or too many lines set aside) the lines here are
      // break lines only, and no deal may run on them.
      if (!dealsOn) {
        nb = 0;
        bundles = []; // the deal block below then has nothing to apply
      }
      const perLine = D_DEFER_LINE + D_DEFER_SCAN * nb;
      if (D_DEFER_FIXED + dn * (perLine + D_DEFER_MEMBER) <= spare) {
        if (dealsOn) {
          try {
            bundles = JSON.parse(bogoRaw);
          } catch {
            bundles = [];
          }
          if (!Array.isArray(bundles)) bundles = [];
        }
        tags = new Array(dn);
        let members = 0;
        let flags = 0;
        for (let j = 0; j < dn; j++) {
          const raw = dRaw[j];
          if (raw.charCodeAt(0) === 43) flags++;
          const lb = raw.lastIndexOf("|", raw.length - 2);
          if (raw.charCodeAt(lb + 1) !== 35) {
            tags[j] = null; // a break line past the allowance, not on a deal
            continue;
          }
          const tag = raw.slice(lb + 2, raw.length - 1);
          tags[j] = tag;
          members++;
          for (let c = tag.indexOf(","); c >= 0; c = tag.indexOf(",", c + 1)) members++;
        }
        affordable = D_DEFER_FIXED + dn * perLine + flags * D_DEFER_FLAG + members * D_DEFER_MEMBER <= spare;
      }

      if (affordable) {
        // Through the same arrays, deal logic and row builder as a small cart.
        size = dn;
        lineIds = new Array(size);
        qty = new Int32Array(size);
        retail = new Float64Array(size);
        retailCents = new Int32Array(size);
        savingCents = new Int32Array(size);
        freeQty = new Int32Array(size);
        dealQty = new Int32Array(size);
        dealSavingCents = new Int32Array(size);
        dealTags = new Array(size);
      }

      for (let j = 0; j < dn; j++) {
        const cartLine = dLine[j];
        const raw = dRaw[j];
        const cents = dCents[j];
        const flagged = raw.charCodeAt(0) === 43;

        if (affordable) {
          const rp = parseFloat(raw);
          if (rp > 0) {
            const slot = count++;
            lineIds[slot] = cartLine.id;
            qty[slot] = cartLine.quantity;
            retail[slot] = rp;
            retailCents[slot] = Math.round(rp * 100);
            // No allowance here: the budget has paid for every one of these.
            savingCents[slot] = flagged
              ? Math.round(tierSaving(raw, dFrom[j], cartLine.quantity, cents / 100) * 100)
              : cents;
            dealTags[slot] = tags[j];
            continue;
          }
        }

        // No room (or no retail to work from): the plain wholesale row, which
        // is what every big cart got before. A break still counts while the
        // ten-line allowance lasts.
        if (flagged && tiersLeft > 0) {
          tiersLeft--;
          const deep = Math.round(tierSaving(raw, dFrom[j], cartLine.quantity, cents / 100) * 100);
          if (deep !== cents) {
            discounts.push({
              targets: [{ cartLine: { id: cartLine.id } }],
              value: { fixedAmount: { amount: money(deep), appliesToEachItem: true } },
              message: "B2B Wholesale Price",
            });
            continue;
          }
        }
        const e = byCents[cents];
        if (e.targets.length === 0) discounts.push(e);
        e.targets.push({ cartLine: { id: cartLine.id } });
      }
    }
  } else {
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
  if (bogoRaw && count > 0) {
    if (bundles === null) {
      try {
        bundles = JSON.parse(bogoRaw);
      } catch {
        bundles = [];
      }
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

  // Big carts: the same rows, but sharing entries (see shareRow).
  const freeBy = byCents === null ? null : {};
  const dealBy = byCents === null ? null : {};

  for (let i = 0; i < count; i++) {
    const retailPrice = retail[i];
    const wholesaleOff = savingCents[i];
    const free = freeQty[i];
    const dealPaid = dealQty[i];
    const wholesaleQty = qty[i] - free - dealPaid;
    const id = lineIds[i];

    if (byCents !== null) {
      const full = qty[i];
      const dealOff = dealSavingCents[i];
      if (free > 0) shareRow(discounts, freeBy, retailCents[i], "Buy X Get Y Free", id, free, full);
      if (dealOff === wholesaleOff) {
        const tierQty = dealPaid + wholesaleQty;
        if (tierQty > 0 && wholesaleOff > 0) shareRow(discounts, byCents, wholesaleOff, "B2B Wholesale Price", id, tierQty, full);
      } else {
        if (dealPaid > 0 && dealOff > 0) shareRow(discounts, dealBy, dealOff, "Deal Price", id, dealPaid, full);
        if (wholesaleQty > 0 && wholesaleOff > 0) shareRow(discounts, byCents, wholesaleOff, "B2B Wholesale Price", id, wholesaleQty, full);
      }
      continue;
    }

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
