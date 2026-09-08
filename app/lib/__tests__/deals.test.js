// Pins who can see the "Special Deals" menu item.
//
// The rule the business cares about: a buyer whose catalog no deal targets must
// never be shown the link. Getting this wrong in the permissive direction sends
// buyers to offers they cannot have, which is the confusion this exists to stop.
import { describe, test, expect } from "vitest";
import { isDealEligible } from "../deals.server.js";

const GENERAL = "gid://shopify/PriceList/34326708537";
const TEEG    = "gid://shopify/PriceList/34326937913";
const HEND    = "gid://shopify/PriceList/34327036217";
const NND     = "gid://shopify/PriceList/34326905145";

// The live config as of 2026-09-08: all five deals scoped to General only.
const generalOnly = { anyCatalog: false, priceListIds: [GENERAL] };

describe("Special Deals menu eligibility", () => {
  test("General Catalog buyers see it", () => {
    expect(isDealEligible(generalOnly, [GENERAL])).toBe(true);
  });

  test("every other catalog does not", () => {
    for (const pl of [TEEG, HEND, NND]) {
      expect(isDealEligible(generalOnly, [pl])).toBe(false);
    }
  });

  test("a buyer on two catalogs sees it if either one has a deal", () => {
    // Night n Day - Denise is on General AND Night N Day. She can genuinely
    // buy the General deals, so hiding the link from her would be wrong.
    expect(isDealEligible(generalOnly, [GENERAL, NND])).toBe(true);
    // Zone Bowling Henderson is on TEEG and its own list, neither of which has
    // a deal.
    expect(isDealEligible(generalOnly, [TEEG, HEND])).toBe(false);
  });

  test("a deal with no catalog restriction opens the menu to everyone", () => {
    const unrestricted = { anyCatalog: true, priceListIds: [] };
    expect(isDealEligible(unrestricted, [TEEG])).toBe(true);
    expect(isDealEligible(unrestricted, [])).toBe(true);
  });

  test("unknown stays unknown, and is never reported as eligible", () => {
    // The storefront leaves the item hidden on null, so these must not be true.
    expect(isDealEligible(null, [GENERAL])).toBeNull();
    expect(isDealEligible(generalOnly, [])).toBeNull();
    expect(isDealEligible(generalOnly, null)).toBeNull();
  });

  test("no deals configured means nobody sees it", () => {
    const none = { anyCatalog: false, priceListIds: [] };
    expect(isDealEligible(none, [GENERAL])).toBe(false);
    expect(isDealEligible(none, [TEEG])).toBe(false);
  });
});
