// Regression guard for volume pricing: with no breaks anywhere, the Function must
// price byte-for-byte like the version live before it (tests/fixtures/run.pre-volume.js,
// a copy of the 6 Oct 2026 code). The only intended difference is the line guard,
// 110 -> 108, so sizes above 108 are checked separately.
import { test, expect } from "vitest";
import { run as newRun } from "../src/run.js";
import { run as oldRun } from "./fixtures/run.pre-volume.js";
// deterministic PRNG
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const PL = "gid://shopify/PriceList/111";
test("no breaks anywhere: new == old on 4000 random carts (incl. deals, big carts, other catalogs)", () => {
  let tiersSeen = 0;
  for (let c = 0; c < 4000; c++) {
    const n = [1, 2, 5, 20, 64, 66, 90, 107, 108][Math.floor(rnd() * 9)];
    const lines = [];
    for (let i = 0; i < n; i++) {
      const retail = (5 + rnd() * 200).toFixed(2); const sav = rnd() < 0.2 ? null : (rnd() * retail * 0.4).toFixed(2);
      let raw = retail + "|";
      if (rnd() < 0.3) raw += `222:${(rnd() * 5).toFixed(2)}|`;
      if (sav !== null) raw += `111:${sav}|`;
      if (rnd() < 0.3) raw += "#dragon,musashi|";
      lines.push({ id: `gid://shopify/CartLine/${i}`, quantity: 1 + Math.floor(rnd() * 40), merchandise: { __typename: "ProductVariant", catSavings: rnd() < 0.05 ? null : { value: raw } } });
    }
    const bundles = rnd() < 0.6 ? [{ i: "dragon", b: 5, g: 1, o: rnd() < 0.5 ? 10 : 0 }, { i: "musashi", b: 10, g: 1 }] : null;
    const input = { discountNode: bundles ? { bogoBundles: { value: JSON.stringify(bundles) } } : {}, cart: { buyerIdentity: rnd() < 0.05 ? {} : { purchasingCompany: { company: { priceListId: { value: PL } } } }, lines } };
    expect(JSON.stringify(newRun(input))).toBe(JSON.stringify(oldRun(input)));
    tiersSeen++;
  }
  expect(tiersSeen).toBe(4000);
});

test("109+ lines: the new guard (108) stands down; behaviour above the guard is exactly 'no discount, native price'", () => {
  for (const n of [109, 110, 111, 150]) {
    const lines = Array.from({ length: n }, (_, i) => ({ id: `gid://shopify/CartLine/${i}`, quantity: 3, merchandise: { __typename: "ProductVariant", catSavings: { value: "40.00|111:5.00|" } } }));
    const input = { discountNode: {}, cart: { buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL } } } }, lines } };
    expect(newRun(input).discounts).toEqual([]);
  }
});
