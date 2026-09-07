// The safety property, stated directly: for a cart of ANY size, the customer
// is never charged more than their catalog price -- including when the discount
// Function fails outright.
//
// The two Functions are modelled as the platform runs them: the transform first,
// then the discount on whatever the transform left behind. "Discount fails" is
// modelled as the discount simply not running, which is what a blown input cap
// looks like from the buyer's side.
import { describe, test, expect } from "vitest";
import { run as discountRun } from "../src/run.js";
import { run as transformRun } from "../../b2b-price-transformer/src/run.js";

const PL = "gid://shopify/PriceList/111";

function buildCart(lineCount, { catalog = 15.0, retail = 20.0 } = {}) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push({
      id: `gid://shopify/CartLine/${i}`,
      quantity: 2,
      // Shopify hands the Function the native catalog price to begin with.
      cost: { amountPerQuantity: { amount: String(catalog) } },
      merchandise: {
        __typename: "ProductVariant",
        id: `gid://shopify/ProductVariant/${1000 + i}`,
        fixedPrices: { value: JSON.stringify({ [PL]: String(catalog) }) },
        standardRetail: { value: String(retail) },
      },
    });
  }
  return {
    discountNode: {},
    cart: {
      buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL }, discountPct: { value: "0" } } } },
      lines,
    },
  };
}

/** Run transform then discount, returning the final per-unit price of line 0. */
function finalPrice(lineCount, { discountRuns }) {
  const cart = buildCart(lineCount);
  const catalog = parseFloat(cart.cart.lines[0].cost.amountPerQuantity.amount);

  const tResult = transformRun(structuredClone(cart));
  const raise = (tResult.operations ?? []).find((o) => o.update?.cartLineId === cart.cart.lines[0].id);
  const afterTransform = raise
    ? parseFloat(raise.update.price.adjustment.fixedPricePerUnit.amount)
    : catalog;

  if (!discountRuns) return afterTransform;

  const priced = structuredClone(cart);
  for (const l of priced.cart.lines) {
    const op = (tResult.operations ?? []).find((o) => o.update?.cartLineId === l.id);
    if (op) l.cost.amountPerQuantity.amount = op.update.price.adjustment.fixedPricePerUnit.amount;
  }
  const dResult = discountRun(priced);
  const d = (dResult.discounts ?? []).find((x) => x.targets.some((t) => t.cartLine.id === cart.cart.lines[0].id));
  return d ? afterTransform - parseFloat(d.value.fixedAmount.amount) : afterTransform;
}

describe("no cart size can be overcharged", () => {
  const sizes = [1, 5, 20, 40, 45, 46, 47, 48, 59, 60, 61, 72, 100, 104, 150, 250];

  test("with the discount Function working, every size lands on catalog price", () => {
    for (const n of sizes) {
      expect(`${n} lines -> ${finalPrice(n, { discountRuns: true })}`).toBe(`${n} lines -> 15`);
    }
  });

  test("above the guard, no size is charged above catalog even if the discount is DEAD", () => {
    for (const n of sizes.filter((n) => n > 45)) {
      const price = finalPrice(n, { discountRuns: false });
      expect(`${n} lines -> ${price <= 15.000001 ? "catalog or better" : `OVERCHARGED at ${price}`}`)
        .toBe(`${n} lines -> catalog or better`);
    }
  });

  // Stated plainly so nobody mistakes the guard for total protection: below it,
  // prices are still raised, so a discount Function that dies for a reason other
  // than cart size (deploy gap, deactivated discount, crash -- what happened on
  // 2 Sept 2026) still bills full retail. The guard closes the size-related
  // band, which caused every overcharge found in the 21 May - 6 Sept audit; it
  // cannot close this one. Detection at order time is the backstop.
  test("KNOWN RESIDUAL: below the guard, a dead discount Function still bills retail", () => {
    expect(finalPrice(30, { discountRuns: false })).toBe(20);
  });

  test("the transform stands down above its line guard", () => {
    expect(transformRun(buildCart(45)).operations.length).toBe(45);
    expect(transformRun(buildCart(46)).operations).toEqual([]);
    expect(transformRun(buildCart(104)).operations).toEqual([]);
  });
});
