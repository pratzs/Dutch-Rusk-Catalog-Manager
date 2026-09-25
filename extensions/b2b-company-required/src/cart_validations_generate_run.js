// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// Once the storefront is opened to the public so reps can show the range, the
// theme hides prices and add-to-cart from anyone without a company. This is
// the server-side backstop: the theme cannot stop someone calling the cart
// URLs directly, but a checkout without a company never completes here.
//
// It is deliberately narrow, because a false positive would stop a real
// customer ordering. It only blocks when EVERY one of these holds:
//
//   1. The buyer is in checkout. Cart interactions are never blocked: a
//      validation error there also rejects add-to-cart, and misreading a
//      genuine B2B cart at that stage would stop every customer adding stock.
//      An unknown step is let through too.
//   2. It is not a Point of Sale sale. POS orders carry no company (286 of
//      them from 25 Jun to 25 Sep 2026, every one) and must keep working.
//   3. There is no purchasing company. All 556 online store orders in the
//      same window had one, so no past online order would have been blocked.
//   4. The customer is not tagged `wholesale-checkout-exempt`, the office's
//      escape hatch for a one-off (for example an invoiced draft order to a
//      customer who has no company yet).

export const BLOCK_MESSAGE =
  "Ordering is for Dutch Rusk wholesale accounts. Please log in with your business account, " +
  "or contact admin@dutchrusk.co.nz or 03 547 7809 to set one up.";

const CHECKOUT_STEPS = new Set(["CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"]);

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const step = input.buyerJourney?.step;
  const cart = input.cart;
  const identity = cart?.buyerIdentity;

  const block =
    CHECKOUT_STEPS.has(String(step)) &&
    !cart?.retailLocation &&
    !identity?.purchasingCompany?.company?.id &&
    !identity?.customer?.exempt;

  return {
    operations: [
      {
        validationAdd: {
          errors: block ? [{ message: BLOCK_MESSAGE, target: "$.cart" }] : [],
        },
      },
    ],
  };
}
