// Pins which orders must raise an alert about their discount rows.
//
// Every case below is a real order. The one that matters most is #1920: 56
// lines, correct prices, zero discount rows. The previous check excluded any
// cart over the line guard, so it said nothing, and the first anyone knew was
// the merchant spotting it in the admin.
import { describe, test, expect } from "vitest";
import { classifyPricingRows, TRANSFORM_LINE_GUARD } from "../pricing-flags.server.js";

/** Build n lines, each with a catalog saving, `struck` of them discounted. */
function order({ n, struck, deals = 0 }) {
  const lineItems = [];
  const catalogByVariant = {};
  const retailByVariant = {};
  const dealVariantIds = new Set();
  for (let i = 0; i < n; i++) {
    const id = String(1000 + i);
    lineItems.push({
      variant_id: id,
      quantity: 2,
      discount_allocations: i < struck ? [{ amount: "4.00" }] : [],
    });
    retailByVariant[id] = 10;
    catalogByVariant[id] = { price: 8, sku: `SKU${i}` };
    if (i < deals) dealVariantIds.add(id);
  }
  return { lineItems, catalogByVariant, retailByVariant, dealVariantIds };
}

describe("discount row alerts", () => {
  test("#1920: 56 lines, no rows, over the guard -- must alert", () => {
    const r = classifyPricingRows(order({ n: 56, struck: 0 }));
    expect(r.overGuard).toBe(true);
    expect(r.missingRows).toBe(true);
    // The whole point. This used to be false.
    expect(r.shouldAlert).toBe(true);
  });

  test("#1904 at 65 lines and #1914 at 48 both alert", () => {
    for (const n of [65, 48]) {
      const r = classifyPricingRows(order({ n, struck: 0 }));
      expect(r.shouldAlert).toBe(true);
      expect(r.missingRows).toBe(true);
    }
  });

  test("#1894/#1895: no rows UNDER the guard still alerts, and is not blamed on cart size", () => {
    const r = classifyPricingRows(order({ n: 4, struck: 0 }));
    expect(r.missingRows).toBe(true);
    expect(r.overGuard).toBe(false); // so the alert tells them to look elsewhere
    expect(r.shouldAlert).toBe(true);
  });

  test("#1909: some lines struck and some not is caught, though the order total looks fine", () => {
    const r = classifyPricingRows(order({ n: 39, struck: 2 }));
    expect(r.missingRows).toBe(false); // a non-zero discount total hides it
    expect(r.partialRows).toBe(true);
    expect(r.linesStruck).toBe(2);
    expect(r.linesWithSaving).toBe(39);
    expect(r.shouldAlert).toBe(true);
  });

  test("a fully struck order stays quiet", () => {
    const r = classifyPricingRows(order({ n: 29, struck: 29 }));
    expect(r.shouldAlert).toBe(false);
  });

  test("a big fully struck order stays quiet even over the guard", () => {
    // Over the guard is not itself a fault: if the rows are there, say nothing.
    const r = classifyPricingRows(order({ n: 80, struck: 80 }));
    expect(r.overGuard).toBe(true);
    expect(r.shouldAlert).toBe(false);
  });

  test("no saving available means nothing to alert about", () => {
    // Catalog price equals retail: this buyer has no discount on these lines.
    const o = order({ n: 10, struck: 0 });
    for (const k of Object.keys(o.catalogByVariant)) o.catalogByVariant[k].price = 10;
    const r = classifyPricingRows(o);
    expect(r.discountWasAvailable).toBe(false);
    expect(r.shouldAlert).toBe(false);
  });

  test("deal lines are exempt from the per-line check but not from 'no rows at all'", () => {
    // A BOGO deliberately prices paid units above catalog, so deal lines must
    // never be counted as a line that is missing its discount.
    const r = classifyPricingRows(order({ n: 6, struck: 0, deals: 6 }));
    expect(r.skippedDealLines).toBe(6);
    expect(r.linesWithSavingNoRow).toBe(0);

    // But a cart of deal products carrying ZERO rows is still wrong: if the
    // deal fired there would be a free-unit row, and if it did not fire (the
    // quantities are below the threshold) the ordinary wholesale discount
    // should have applied. Either way something did not run.
    expect(r.missingRows).toBe(true);
    expect(r.shouldAlert).toBe(true);
  });

  test("a deal cart that did produce rows stays quiet", () => {
    const o = order({ n: 6, struck: 0, deals: 6 });
    o.lineItems[0].discount_allocations = [{ amount: "9.00" }]; // the free unit
    const r = classifyPricingRows(o);
    expect(r.shouldAlert).toBe(false);
  });

  test("deal lines with rows do not mask ordinary lines without them", () => {
    // #1913: the struck lines were the deal lines, the other 38 got nothing.
    const o = order({ n: 48, struck: 0, deals: 10 });
    for (let i = 0; i < 10; i++) o.lineItems[i].discount_allocations = [{ amount: "2.00" }];
    const r = classifyPricingRows(o);
    expect(r.missingRows).toBe(false); // deal rows make the total non-zero
    expect(r.partialRows).toBe(true);
    expect(r.linesWithSavingNoRow).toBe(38);
    expect(r.shouldAlert).toBe(true);
  });

  test("lines with no variant are ignored (shipping, custom items)", () => {
    const o = order({ n: 3, struck: 3 });
    o.lineItems.push({ variant_id: null, quantity: 1, discount_allocations: [] });
    const r = classifyPricingRows(o);
    expect(r.lineCount).toBe(3);
    expect(r.shouldAlert).toBe(false);
  });

  test("an empty order does not alert", () => {
    const r = classifyPricingRows({
      lineItems: [], catalogByVariant: {}, retailByVariant: {}, dealVariantIds: new Set(),
    });
    expect(r.shouldAlert).toBe(false);
  });

  test("the guard boundary is exact", () => {
    expect(classifyPricingRows(order({ n: TRANSFORM_LINE_GUARD, struck: 0 })).overGuard).toBe(false);
    expect(classifyPricingRows(order({ n: TRANSFORM_LINE_GUARD + 1, struck: 0 })).overGuard).toBe(true);
    // Either way it alerts.
    expect(classifyPricingRows(order({ n: TRANSFORM_LINE_GUARD, struck: 0 })).shouldAlert).toBe(true);
    expect(classifyPricingRows(order({ n: TRANSFORM_LINE_GUARD + 1, struck: 0 })).shouldAlert).toBe(true);
  });
});
