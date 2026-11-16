// The big-cart budget (16 Nov 2026). Above 65 lines the two Functions no longer
// stop at a fixed 108 lines: both walk the cart adding up a cost model and cover
// lines until the budget is spent. These tests pin the three things that matter:
//
//   1. They always agree on WHICH lines are covered. A line raised but not
//      discounted bills retail; a line discounted but not raised is discounted
//      twice. Neither may ever happen.
//   2. Every covered line lands on exactly the price it did before.
//   3. Anything the old code covered on a realistic cart is still covered.
//
// tests/fixtures/*.pre-budget.js are copies of the code live before this change.
import { describe, test, expect } from "vitest";
import { run as discountRun } from "../src/run.js";
import { run as transformRun } from "../../b2b-price-transformer/src/run.js";
import { run as oldDiscountRun } from "./fixtures/run.pre-budget.js";
import { run as oldTransformRun } from "./fixtures/transform.pre-budget.js";

let seed = 20261116;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const PL = "gid://shopify/PriceList/111";

/** distinct: roughly how many different savings the cart has (Infinity = all different). */
function cart(n, { distinct = Infinity, tiers = 0.03, gaps = 0.1, deals = false } = {}) {
  const pool = Number.isFinite(distinct) ? Array.from({ length: distinct }, () => (0.3 + rnd() * 30).toFixed(2)) : null;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const sav = pool ? pool[Math.floor(rnd() * pool.length)] : (0.3 + i * 0.07 + rnd() * 0.05).toFixed(2);
    const retail = (parseFloat(sav) * (2 + rnd() * 3)).toFixed(2);
    const r = rnd();
    let raw;
    if (r < gaps / 2) raw = null; // not synced / not a variant
    else if (r < gaps) raw = `${retail}|222:${sav}|`; // only another catalog discounts it
    else if (rnd() < tiers) raw = `+${retail}|222:1.00@6=1.50|111:${sav}@12=${(parseFloat(sav) + 0.4).toFixed(2)}@24=${(parseFloat(sav) + 0.9).toFixed(2)}|`;
    else raw = `${retail}|222:0.40|111:${sav}|${rnd() < 0.1 ? "#dragon|" : ""}`;
    lines.push({ id: `gid://shopify/CartLine/${i}`, quantity: 1 + Math.floor(rnd() * 30), merchandise: { __typename: "ProductVariant", catSavings: raw === null ? null : { value: raw } } });
  }
  return {
    discountNode: deals ? { bogoBundles: { value: JSON.stringify([{ i: "dragon", b: 5, g: 1, o: 10 }]) } } : {},
    cart: { buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL } } } }, lines },
  };
}

/** line id -> retail the transform raised it to */
const raisedBy = (run, input) =>
  new Map((run(structuredClone(input)).operations ?? []).map((o) => [o.update.cartLineId, o.update.price.adjustment.fixedPricePerUnit.amount]));

/** line id -> "units@amount" rows, so old (one entry per line) and new (shared entries) compare like for like */
function discountedBy(run, input) {
  const qty = new Map(input.cart.lines.map((l) => [l.id, l.quantity]));
  const out = new Map();
  for (const d of run(structuredClone(input)).discounts ?? []) {
    for (const t of d.targets) {
      const id = t.cartLine.id;
      const units = t.cartLine.quantity ?? qty.get(id);
      out.set(id, [...(out.get(id) ?? []), `${units}@${d.value.fixedAmount.amount}:${d.message}`].sort());
    }
  }
  return out;
}
const asObj = (m) => Object.fromEntries([...m].sort());
const eligibleLines = (input) => input.cart.lines.filter((l) => l.merchandise.catSavings?.value.includes("|111:"));

describe("big-cart budget", { timeout: 120000 }, () => {
  test("the two Functions cover exactly the same lines, on 3000 random carts of 1-260 lines", () => {
    let partial = 0;
    for (let c = 0; c < 3000; c++) {
      const n = 1 + Math.floor(rnd() * 260);
      const input = cart(n, { distinct: [Infinity, 5, 20, 50, 90][Math.floor(rnd() * 5)], tiers: rnd() < 0.5 ? 0.03 : 0.5, deals: rnd() < 0.3 });
      const raised = raisedBy(transformRun, input);
      const discounted = discountedBy(discountRun, input);
      expect([...discounted.keys()].sort()).toEqual([...raised.keys()].sort());
      if (raised.size > 0 && raised.size < eligibleLines(input).length) partial++;
      if (n > 250) expect(raised.size).toBe(0);
    }
    expect(partial).toBeGreaterThan(50); // the budget really was exercised
  });

  test("65 lines or fewer: both Functions answer exactly as before", () => {
    for (let c = 0; c < 2000; c++) {
      const input = cart(1 + Math.floor(rnd() * 65), { distinct: rnd() < 0.5 ? Infinity : 12, tiers: 0.2, deals: rnd() < 0.5 });
      expect(JSON.stringify(discountRun(structuredClone(input)))).toBe(JSON.stringify(oldDiscountRun(structuredClone(input))));
      expect(asObj(raisedBy(transformRun, input))).toEqual(asObj(raisedBy(oldTransformRun, input)));
    }
  });

  test("66-108 lines with repeated savings (what real orders look like): same lines, same money as before", () => {
    for (let c = 0; c < 1500; c++) {
      const n = 66 + Math.floor(rnd() * 43);
      const input = cart(n, { distinct: 10 + Math.floor(rnd() * 50), tiers: rnd() < 0.5 ? 0.03 : 0.3 });
      expect(asObj(raisedBy(transformRun, input))).toEqual(asObj(raisedBy(oldTransformRun, input)));
      const now = discountedBy(discountRun, input);
      const old = discountedBy(oldDiscountRun, input);
      expect([...now.keys()].sort()).toEqual([...old.keys()].sort());
      for (const l of input.cart.lines) {
        if (!now.has(l.id)) continue;
        // Since 16 Nov 2026 a volume-break line past the old ten-line allowance
        // can get its break too. That may only ever deepen the saving.
        if (l.merchandise.catSavings.value.startsWith("+")) {
          const amt = (rows) => parseFloat(rows[0].split("@")[1]);
          expect(now.get(l.id).length).toBe(1);
          expect(amt(now.get(l.id))).toBeGreaterThanOrEqual(amt(old.get(l.id)));
        } else {
          expect(now.get(l.id)).toEqual(old.get(l.id));
        }
      }
    }
  });

  test("109-130 lines with repeated savings: every eligible line is now covered, at the right money", () => {
    for (let c = 0; c < 500; c++) {
      const n = 109 + Math.floor(rnd() * 22);
      const input = cart(n, { distinct: 20 + Math.floor(rnd() * 40), tiers: 0.03, gaps: 0.05 });
      const eligible = eligibleLines(input);
      const raised = raisedBy(transformRun, input);
      const discounted = discountedBy(discountRun, input);
      expect(raised.size).toBe(eligible.length);
      for (const l of eligible) {
        const raw = l.merchandise.catSavings.value;
        expect(parseFloat(raised.get(l.id))).toBe(parseFloat(raw));
        const rows = discounted.get(l.id);
        expect(rows.length).toBe(1);
        const off = parseFloat(rows[0].split("@")[1]);
        const base = parseFloat(raw.slice(raw.indexOf("|111:") + 5));
        expect(off).toBeGreaterThanOrEqual(base); // a volume break may deepen it, never shallower
        expect(rows[0].startsWith(`${l.quantity}@`)).toBe(true); // whole line
        expect(rows[0].endsWith(":B2B Wholesale Price")).toBe(true);
      }
    }
  });

  test("the budget stops in cart order: covered lines are a prefix, the rest are untouched", () => {
    const input = cart(200, { distinct: Infinity, tiers: 0, gaps: 0 });
    const raised = raisedBy(transformRun, input);
    expect(raised.size).toBeGreaterThan(40);
    expect(raised.size).toBeLessThan(200);
    input.cart.lines.forEach((l, i) => expect(raised.has(l.id)).toBe(i < raised.size));
  });

  test("a pathological 108-line cart where every saving is different is covered in part, not dropped", () => {
    const input = cart(108, { distinct: Infinity, tiers: 0, gaps: 0 });
    const raised = raisedBy(transformRun, input);
    expect(raised.size).toBeGreaterThanOrEqual(90);
    expect([...discountedBy(discountRun, input).keys()].sort()).toEqual([...raised.keys()].sort());
  });

  test("retail passes through as text, flag stripped, and a zero retail is never raised to", () => {
    const one = (raw) =>
      raisedBy(transformRun, {
        cart: { buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL } } } }, lines: [{ id: "x", merchandise: { catSavings: { value: raw } } }] },
      }).get("x");
    expect(one("27.75|111:5.25|")).toBe("27.75");
    expect(one("+0.90|111:0.10@12=0.20|")).toBe("0.90");
    expect(one("0.00|111:5.25|")).toBeUndefined();
    expect(one("|111:5.25|")).toBeUndefined();
  });
});
