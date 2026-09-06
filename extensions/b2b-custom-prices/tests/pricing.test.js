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

/** Build one cart line. `retail` is the price AFTER the cart transform raised it. */
function line(id, variantId, quantity, retail, catalog, { standardRetail = retail } = {}) {
  const fixed = {};
  if (catalog !== null) fixed[PL] = String(catalog);
  return {
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    cost: { amountPerQuantity: { amount: String(retail) } },
    merchandise: {
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${variantId}`,
      fixedPrices: { value: JSON.stringify(fixed) },
      standardRetail: { value: String(standardRetail) },
    },
  };
}

function input(lines, { priceListId = PL, discountPct = "0", bundles = null } = {}) {
  return {
    discountNode: bundles ? { bogoBundles: { value: JSON.stringify(bundles) } } : {},
    cart: {
      buyerIdentity: priceListId
        ? { purchasingCompany: { company: { priceListId: { value: priceListId }, discountPct: { value: discountPct } } } }
        : {},
      lines,
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
