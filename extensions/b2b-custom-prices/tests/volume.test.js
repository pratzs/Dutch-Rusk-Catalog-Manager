// Volume pricing: a catalog's quantity price breaks, carried inside its entry of
// custom.catalog_savings as "<saving>@<min qty>=<saving at that qty>".
//
//   27.75|111:5.25@12=9.10@24=11.50|
//
// The rules pinned here, as FINAL PER-UNIT PRICES:
//   - below the first break: the catalog price, exactly as before
//   - at or above a break: retail minus that break's saving (the deepest one
//     the line qualifies for)
//   - a break never makes a price WORSE than the base catalog price
//   - another catalog's breaks, or malformed ones, change nothing
import { describe, test, expect } from "vitest";
import { run } from "../src/run.js";

const PL = "gid://shopify/PriceList/111";
const OTHER = "222";

function cartLine(n, qty, raw) {
  return {
    id: `gid://shopify/CartLine/${n}`,
    quantity: qty,
    merchandise: { __typename: "ProductVariant", catSavings: { value: raw } },
  };
}
const input = (lines, { bundles = null } = {}) => ({
  discountNode: bundles ? { bogoBundles: { value: JSON.stringify(bundles) } } : {},
  cart: { buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL } } } }, lines },
});

/** Final per-unit price of a line (single tier lines only), or null if none. */
function unit(result, n, retail) {
  const d = (result.discounts ?? []).filter((x) => x.targets[0].cartLine.id === `gid://shopify/CartLine/${n}`);
  if (!d.length) return null;
  expect(d.length).toBe(1);
  return +(retail - parseFloat(d[0].value.fixedAmount.amount)).toFixed(2);
}

// Metromart Bic Lighters Outer: retail 80, base 61.20 (saving 18.80), 12+ at 47.83 (saving 32.17)
const BIC = "+80.00|111:18.80@12=32.17|";

describe("volume pricing", () => {
  test("below the break: the base catalog price, as before", () => {
    expect(unit(run(input([cartLine(1, 11, BIC)])), 1, 80)).toBe(61.2);
    expect(unit(run(input([cartLine(1, 1, BIC)])), 1, 80)).toBe(61.2);
  });

  test("at the break and above: the break price", () => {
    expect(unit(run(input([cartLine(1, 12, BIC)])), 1, 80)).toBe(47.83);
    expect(unit(run(input([cartLine(1, 500, BIC)])), 1, 80)).toBe(47.83);
  });

  test("several breaks: the deepest one the line qualifies for", () => {
    const raw = "+80.00|111:18.80@12=32.17@24=36.00|";
    expect(unit(run(input([cartLine(1, 11, raw)])), 1, 80)).toBe(61.2);
    expect(unit(run(input([cartLine(1, 12, raw)])), 1, 80)).toBe(47.83);
    expect(unit(run(input([cartLine(1, 23, raw)])), 1, 80)).toBe(47.83);
    expect(unit(run(input([cartLine(1, 24, raw)])), 1, 80)).toBe(44.0);
  });

  test("breaks apply per line, not across lines", () => {
    const out = run(input([cartLine(1, 8, BIC), cartLine(2, 8, BIC)]));
    expect(unit(out, 1, 80)).toBe(61.2);
    expect(unit(out, 2, 80)).toBe(61.2);
  });

  test("the message on the discount row is still B2B Wholesale Price", () => {
    const out = run(input([cartLine(1, 12, BIC)]));
    expect(out.discounts[0].message).toBe("B2B Wholesale Price");
    expect(out.discounts[0].targets[0].cartLine.quantity).toBe(12);
  });

  test("another catalog's breaks never leak in", () => {
    const raw = `+80.00|111:18.80|${OTHER}:20.00@12=40.00|`;
    expect(unit(run(input([cartLine(1, 12, raw)])), 1, 80)).toBe(61.2);
    // and the buyer's own breaks are found even when another catalog's come first
    const raw2 = `+80.00|${OTHER}:20.00@12=40.00|111:18.80@12=32.17|`;
    expect(unit(run(input([cartLine(1, 12, raw2)])), 1, 80)).toBe(47.83);
    expect(unit(run(input([cartLine(1, 11, raw2)])), 1, 80)).toBe(61.2);
  });

  test("a break shallower than the base price is ignored", () => {
    const raw = "+80.00|111:18.80@12=5.00|";
    expect(unit(run(input([cartLine(1, 12, raw)])), 1, 80)).toBe(61.2);
  });

  test("malformed breaks fall back to the base price, never to retail", () => {
    for (const raw of ["+80.00|111:18.80@|", "+80.00|111:18.80@12|", "+80.00|111:18.80@x=5|", "+80.00|111:18.80@12=|", "+80.00|111:18.80@0=30|", "+80.00|111:18.80@-3=30|", "+80.00|111:18.80@=30|"]) {
      expect(unit(run(input([cartLine(1, 12, raw)])), 1, 80)).toBe(61.2);
    }
  });

  test("the string format is readable by the old code: parseFloat stops at the @", () => {
    const base = "18.80@12=32.17|";
    expect(parseFloat(base)).toBe(18.8);
  });

  test("a line the catalog does not discount is still left alone", () => {
    expect(run(input([cartLine(1, 12, `+80.00|${OTHER}:5.00@12=9.00|`)])).discounts).toEqual([]);
    expect(run(input([cartLine(1, 12, "80.00|")])).discounts).toEqual([]);
  });

  test("big carts (the fast path above 65 lines) honour breaks too", () => {
    const lines = [];
    for (let i = 1; i <= 90; i++) lines.push(cartLine(i, i === 7 ? 12 : 3, BIC));
    const out = run(input(lines));
    expect(unit(out, 7, 80)).toBe(47.83);
    expect(unit(out, 8, 80)).toBe(61.2);
  });

  test("a BOGO deal on the same variant still works, and beyond-deal units take the break", () => {
    const bundles = [{ i: "dragon", b: 5, g: 1 }];
    const raw = "+80.00|111:18.80@12=32.17|#dragon|";
    // 14 units: 2 groups of 6 consume 12 (10 paid at retail + 2 free), 2 beyond the deal
    const out = run(input([cartLine(1, 14, raw)], { bundles }));
    const free = out.discounts.find((d) => d.message === "Buy X Get Y Free");
    expect(free.targets[0].cartLine.quantity).toBe(2);
    const beyond = out.discounts.filter((d) => d.message === "B2B Wholesale Price");
    expect(beyond.reduce((a, d) => a + d.targets[0].cartLine.quantity, 0)).toBeGreaterThan(0);
    // a line at 14 qualifies for the 12+ break, so the beyond-deal saving is the deeper one
    expect(parseFloat(beyond[0].value.fixedAmount.amount)).toBe(32.17);
  });

  test("breaks only count on a flagged (+) string; an unflagged @ is ignored, base price applies", () => {
    expect(unit(run(input([cartLine(1, 12, "80.00|111:18.80@12=32.17|")])), 1, 80)).toBe(61.2);
  });

  test("a cart honours breaks on a limited number of lines; the rest pay their normal catalog price", () => {
    const lines = [];
    for (let i = 1; i <= 100; i++) lines.push(cartLine(i, 12, BIC)); // 100 lines, all qualify
    const out = run(input(lines));
    let broken = 0, base = 0;
    for (let i = 1; i <= 100; i++) { const u = unit(out, i, 80); if (u === 47.83) broken++; else { expect(u).toBe(61.2); base++; } }
    expect(broken).toBe(10); // 100 lines: allowance is 10
    expect(base).toBe(90);
    const small = run(input(Array.from({ length: 30 }, (_, i) => cartLine(i + 1, 12, BIC))));
    expect(Array.from({ length: 30 }, (_, i) => unit(small, i + 1, 80)).every((u) => u === 47.83)).toBe(true);
  });

  test("a line with no breaks is byte-identical to the old behaviour", () => {
    const out = run(input([cartLine(1, 5, "20.00|111:5.00|")]));
    expect(out.discounts).toEqual([
      { targets: [{ cartLine: { id: "gid://shopify/CartLine/1", quantity: 5 } }], value: { fixedAmount: { amount: "5.00", appliesToEachItem: true } }, message: "B2B Wholesale Price" },
    ]);
  });
});
