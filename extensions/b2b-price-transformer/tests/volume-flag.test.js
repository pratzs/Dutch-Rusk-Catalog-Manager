// The transform must still raise a volume-priced line to RETAIL: the discount
// Function then takes the (quantity-dependent) saving back off. A "+" flag in
// front of the string, and "@min=saving" pairs after the saving, must not change
// what the transform reads.
import { test, expect } from "vitest";
import { run } from "../src/run.js";

const PL = "gid://shopify/PriceList/111";
const input = (raw) => ({
  cart: {
    buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL } } } },
    lines: [{ id: "gid://shopify/CartLine/1", merchandise: { __typename: "ProductVariant", catSavings: { value: raw } } }],
  },
});
const raised = (raw) => run(input(raw)).operations.map((o) => o.update.price.adjustment.fixedPricePerUnit.amount);

test("a flagged, tiered string raises to retail exactly like a plain one", () => {
  expect(raised("80.00|111:18.80|")).toEqual(["80.00"]);
  expect(raised("+80.00|111:18.80@12=32.17|")).toEqual(["80.00"]);
  expect(raised("+80.00|111:18.80@12=32.17@24=36.00|")).toEqual(["80.00"]);
});
test("a flagged string with no entry for this catalog is left alone", () => {
  expect(run(input("+80.00|222:18.80@12=32.17|")).operations).toEqual([]);
});
test("another catalog's tiers never read as this catalog's saving", () => {
  expect(raised("+80.00|222:5.00@12=9.00|111:18.80|")).toEqual(["80.00"]);
});
