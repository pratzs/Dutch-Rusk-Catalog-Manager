// Unit tests for the pricing maths in src/run.js.
//
// These run the real function directly (no wasm build) so the money rules are
// pinned exactly. The rule being protected here is:
//
//   catalog price is catalog price, unless the unit is actually consumed by an
//   active BOGO deal -- in which case the deal applies exactly as configured.
//
// Every expectation is expressed as the FINAL PER-UNIT PRICE the customer pays,
// because that is the thing that must not drift.
import { describe, test, expect } from "vitest";
import { run } from "../src/run.js";

const PL = "gid://shopify/PriceList/111";
const OTHER_PL = "gid://shopify/PriceList/999";
const shortPl = (gid) => gid.slice(gid.lastIndexOf("/") + 1);

/** Build one cart line. `retail` is the price AFTER the cart transform raised it. */
function line(id, variantId, quantity, retail, catalog, { standardRetail = retail, deals = [] } = {}) {
  // custom.catalog_savings shape: "<retail>|<priceListId>:<saving off retail>|"
  // plus "#dealId,dealId|" when the variant is on a deal.
  const savingOff = catalog === null ? null : +(retail - catalog).toFixed(2);
  const compact =
    `${Number(standardRetail).toFixed(2)}|` +
    (savingOff !== null && savingOff > 0 ? `${shortPl(PL)}:${savingOff}|` : "") +
    (deals.length ? `#${deals.join(",")}|` : "");
  return {
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    cost: { amountPerQuantity: { amount: String(retail) } },
    merchandise: {
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${variantId}`,
      catSavings: { value: compact },
    },
  };
}

/**
 * The Function reads a squeezed copy of the deal config, not the readable one
 * the admin edits. This mirrors forFunction() in app/routes/app.bogo.jsx --
 * keep the two in step, because a mismatch here means deals silently stop
 * applying at checkout while every test still passes.
 */
function forFunction(bundle) {
  const out = {};
  if (bundle.id !== undefined) out.i = bundle.id;
  if (bundle.buyQty !== undefined) out.b = bundle.buyQty;
  if (bundle.getQty !== undefined) out.g = bundle.getQty;
  if (bundle.overridePct !== undefined) out.o = bundle.overridePct;
  if (bundle.catalogIds) out.c = bundle.catalogIds.map(shortPl);
  if (bundle.variantIds) out.v = bundle.variantIds.map(shortPl);
  return out;
}

function input(lines, { priceListId = PL, discountPct = "0", bundles = null } = {}) {
  // Deal membership travels ON the variant now, as ids inside catalog_savings,
  // because the Function no longer receives the variant id. api.catalog-price-sync
  // writes those markers from the bundles' variantIds; this mirrors it so each
  // test can keep declaring bundles the readable way.
  const tagged = lines.map((l) => {
    const ids = (bundles ?? [])
      .filter((b) => (b.variantIds ?? []).includes(l.merchandise.id))
      .map((b) => b.id);
    if (!ids.length) return l;
    const v = l.merchandise.catSavings.value.replace(/#[^|]*\|$/, "");
    return {
      ...l,
      merchandise: { ...l.merchandise, catSavings: { value: `${v}#${ids.join(",")}|` } },
    };
  });

  return {
    discountNode: bundles ? { bogoBundles: { value: JSON.stringify(bundles.map(forFunction)) } } : {},
    cart: {
      buyerIdentity: priceListId
        ? { purchasingCompany: { company: { priceListId: { value: priceListId }, discountPct: { value: discountPct } } } }
        : {},
      lines: tagged,
    },
  };
}

/**
 * Collapse the function's output into { lineId: { qty: unitPrice } } so tests
 * read as "this many units at this price", which is what the buyer sees.
 */
function pricePerUnit(result, lines) {
  const byLine = {};
  for (const l of lines) byLine[l.id] = { remaining: l.quantity, retail: parseFloat(l.cost.amountPerQuantity.amount), tiers: [] };
  for (const d of result.discounts ?? []) {
    for (const t of d.targets) {
      const entry = byLine[t.cartLine.id];
      const off = parseFloat(d.value.fixedAmount.amount);
      entry.tiers.push({ qty: t.cartLine.quantity, unit: +(entry.retail - off).toFixed(2), message: d.message });
      entry.remaining -= t.cartLine.quantity;
    }
  }
  const out = {};
  for (const [id, e] of Object.entries(byLine)) {
    const tiers = [...e.tiers];
    if (e.remaining > 0) tiers.push({ qty: e.remaining, unit: e.retail, message: "(undiscounted)" });
    out[id] = tiers.sort((a, b) => a.unit - b.unit);
  }
  return out;
}

const L = (n) => `gid://shopify/CartLine/${n}`;

describe("catalog pricing is untouched when no BOGO is involved", () => {
  test("no bundles configured at all: every line lands on its catalog price", () => {
    const lines = [line(1, "A", 3, 20.0, 15.0), line(2, "B", 1, 50.0, 44.5)];
    const out = pricePerUnit(run(input(lines)), lines);
    expect(out[L(1)]).toEqual([{ qty: 3, unit: 15.0, message: "B2B Wholesale Price" }]);
    expect(out[L(2)]).toEqual([{ qty: 1, unit: 44.5, message: "B2B Wholesale Price" }]);
  });

  test("bundles exist but this variant is in none of them: catalog price", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, variantIds: ["gid://shopify/ProductVariant/ZZZ"] }];
    const lines = [line(1, "A", 6, 20.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([{ qty: 6, unit: 15.0, message: "B2B Wholesale Price" }]);
  });

  test("variant is in a bundle but quantity is below the deal threshold: catalog price, no free unit", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 5, 20.0, 15.0)]; // needs 6 (5 paid + 1 free)
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([{ qty: 5, unit: 15.0, message: "B2B Wholesale Price" }]);
  });

  test("deal is scoped to other catalogs: this customer keeps catalog price, no free unit", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, catalogIds: [OTHER_PL], variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 6, 20.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([{ qty: 6, unit: 15.0, message: "B2B Wholesale Price" }]);
  });

  test("variant has no catalog price for this price list: left at retail, never invented", () => {
    const lines = [line(1, "A", 2, 20.0, null)];
    const out = pricePerUnit(run(input(lines)), lines);
    expect(out[L(1)]).toEqual([{ qty: 2, unit: 20.0, message: "(undiscounted)" }]);
  });

  test("company has no price list assigned: function emits nothing", () => {
    const lines = [line(1, "A", 2, 20.0, 15.0)];
    expect(run(input(lines, { priceListId: null })).discounts).toEqual([]);
  });
});

describe("an active BOGO deal applies exactly as configured", () => {
  test("buy 5 get 1, no override: 1 free, 5 deal-paid at retail, extras at catalog", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 7, 20.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([
      { qty: 1, unit: 0, message: "Buy X Get Y Free" },
      { qty: 1, unit: 15.0, message: "B2B Wholesale Price" }, // the unit beyond the deal
      { qty: 5, unit: 20.0, message: "(undiscounted)" },      // deal-paid, full retail
    ]);
  });

  test("catalog deeper than the promo: beyond-deal units keep the better catalog price", () => {
    // Catalog 15.00 beats the 10% override (18.00), so the extra unit stays at
    // 15.00. Before this floor it was charged 18.00 -- a promo raising a price.
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 7, 20.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([
      { qty: 1, unit: 0, message: "Buy X Get Y Free" },
      { qty: 1, unit: 15.0, message: "B2B Wholesale Price" }, // beyond the deal: catalog wins
      { qty: 5, unit: 18.0, message: "Deal Price" },          // deal-paid: promo rate
    ]);
  });

  test("promo deeper than catalog: beyond-deal units get the promo rate, as configured", () => {
    // Catalog 19.00 is worse than the 10% override (18.00), so the promo applies
    // to the extra unit too -- the deal is set up as 10% off these products.
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 7, 20.0, 19.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([
      { qty: 1, unit: 0, message: "Buy X Get Y Free" },
      { qty: 6, unit: 18.0, message: "B2B Wholesale Price" }, // deal-paid + extra, same price
    ]);
  });

  test("deal-paid units are never floored at catalog: no catalog-plus-free-unit stack", () => {
    // Catalog 13.77 is far deeper than the 10% promo. The 5 paid units must
    // still be 17.32, not 13.77 -- pairing the catalog rate with a free unit is
    // the loss removed in 13ae4ca.
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 6, 19.25, 13.77)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([
      { qty: 1, unit: 0, message: "Buy X Get Y Free" },
      { qty: 5, unit: 17.32, message: "Deal Price" },
    ]);
  });

  test("deal-paid and catalog prices that coincide collapse into one row", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 7, 20.0, 18.0)]; // catalog == override
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([
      { qty: 1, unit: 0, message: "Buy X Get Y Free" },
      { qty: 6, unit: 18.0, message: "B2B Wholesale Price" },
    ]);
  });

  test("a line matching two overridden bundles takes the cheaper override", () => {
    const ids = ["gid://shopify/ProductVariant/A"];
    const bundles = [
      { id: "d1", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ids },
      { id: "d2", buyQty: 5, getQty: 1, overridePct: 25, variantIds: ids },
    ];
    const lines = [line(1, "A", 6, 20.0, 19.5)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    // 25% off wins over 10% off, so the 5 paid units are 15.00 rather than 18.00.
    // Deal-paid and beyond-deal both land there, so they share one row.
    expect(out[L(1)].filter((t) => t.unit > 0)).toEqual([{ qty: 5, unit: 15.0, message: "B2B Wholesale Price" }]);
  });

  test("free units come off the cheapest matching line first", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, variantIds: ["gid://shopify/ProductVariant/A", "gid://shopify/ProductVariant/B"] }];
    const lines = [line(1, "A", 3, 20.0, 15.0), line(2, "B", 3, 20.0, 9.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(2)][0]).toEqual({ qty: 1, unit: 0, message: "Buy X Get Y Free" });
  });

  test("two deal groups give two free units", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 12, 20.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)].find((t) => t.unit === 0)).toEqual({ qty: 2, unit: 0, message: "Buy X Get Y Free" });
  });
});

describe("a deal never changes the price of products outside it", () => {
  test("mixed cart: deal line takes the deal, unrelated line keeps catalog price", () => {
    const bundles = [{ id: "d", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ["gid://shopify/ProductVariant/A"] }];
    const lines = [line(1, "A", 6, 20.0, 15.0), line(2, "B", 4, 30.0, 21.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(2)]).toEqual([{ qty: 4, unit: 21.0, message: "B2B Wholesale Price" }]);
  });
});

describe("a deal must not discount a line the transform did not raise", () => {
  // The transform stands down above its line guard, and then every line arrives
  // already at the catalog price. A deal computing a percentage off THAT price
  // discounts it twice and hands over a free unit on top. Order #1913 (48 lines,
  // Night n Day) lost roughly $38 that way: eight Dragon bags at the Night n Day
  // rate of 14.00 were taken to 12.60, plus a free unit.
  const bundles = [{ id: "d", buyQty: 5, getQty: 1, overridePct: 10, variantIds: ["gid://shopify/ProductVariant/A"] }];

  test("transform raised the line: the deal applies as configured", () => {
    // cost 20.00 is retail, catalog is 15.00 -> the transform clearly raised it
    const lines = [line(1, "A", 7, 20.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)].some((t) => t.unit === 0)).toBe(true); // free unit given
  });

  test("transform stood down: no free unit, no second discount, catalog price stands", () => {
    // cost 15.00 IS the catalog price -> the transform did not raise this line
    const lines = [line(1, "A", 7, 15.0, 15.0)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([{ qty: 7, unit: 15.0, message: "(undiscounted)" }]);
  });

  test("no catalog discount for this buyer: no deal either, nothing is invented", () => {
    // Changed deliberately on 16 Sept 2026. The Function no longer receives the
    // line cost, so it can no longer tell a raised line from an unraised one
    // per line. It now keys off the same thing the transform does: whether this
    // buyer's catalog actually discounts the variant.
    //
    // A deal product the buyer gets no catalog discount on therefore gets no
    // deal. No deal variant is in that position today (checked live: 0 of 75),
    // and erring this way can only ever under-apply a promotion. The opposite
    // error discounts an already-correct price twice, which is what cost about
    // $38 on order #1913.
    const lines = [line(1, "A", 7, 20.0, null)];
    const out = pricePerUnit(run(input(lines, { bundles })), lines);
    expect(out[L(1)]).toEqual([{ qty: 7, unit: 20.0, message: "(undiscounted)" }]);
  });
});
