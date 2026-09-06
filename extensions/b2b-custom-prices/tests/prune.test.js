// Verifies that pruning custom.catalog_fixed_prices down to genuine discounts
// only (dropping entries where the catalog price is not below standard retail)
// changes NOTHING about the price a customer pays, for every variant on every
// catalog -- while cutting the function input that caused large carts to fail.
//
// Both functions are exercised: the cart transform that raises to retail, and
// the discount that brings it back to catalog.
import fs from "fs";
import path from "path";
import { describe, test, expect } from "vitest";
import { run as discountRun } from "../src/run.js";
import { run as transformRun } from "../../b2b-price-transformer/src/run.js";

const DATA = process.env.AUDIT_DATA_DIR;
const loadJsonl = (f) => fs.readFileSync(path.join(DATA, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Drop map entries that are not a genuine discount against standard retail. */
function prune(map, standardRetail) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const p = parseFloat(v);
    if (isFinite(p) && p < standardRetail - 0.005) out[k] = v;
  }
  return out;
}

function cartFor(variantGid, mapJson, retailValue, priceListId, quantity, linePrice) {
  return {
    discountNode: {},
    cart: {
      buyerIdentity: { purchasingCompany: { company: { priceListId: { value: priceListId }, discountPct: { value: "0" } } } },
      lines: [
        {
          id: "gid://shopify/CartLine/1",
          quantity,
          cost: { amountPerQuantity: { amount: String(linePrice) } },
          merchandise: {
            __typename: "ProductVariant",
            id: variantGid,
            fixedPrices: { value: mapJson },
            standardRetail: { value: String(retailValue) },
          },
        },
      ],
    },
  };
}

describe("pruning the catalog price map", () => {
  test("produces identical transform and discount output for every variant on every catalog", () => {
    const variants = [];
    for (const v of loadJsonl("variants.jsonl")) {
      if (!v.id || !v.id.includes("ProductVariant")) continue;
      if (!v.fixedPrices?.value || !v.standardRetail?.value) continue;
      let map;
      try { map = JSON.parse(v.fixedPrices.value); } catch { continue; }
      variants.push({ gid: v.id, sku: v.sku, retail: parseFloat(v.standardRetail.value), map, raw: v.fixedPrices.value });
    }

    let cases = 0, transformMismatch = 0, discountMismatch = 0, bytesFull = 0, bytesPruned = 0;
    const examples = [];

    for (const v of variants) {
      const prunedMap = prune(v.map, v.retail);
      const prunedJson = JSON.stringify(prunedMap);
      bytesFull += v.raw.length;
      bytesPruned += prunedJson.length;

      for (const priceListId of Object.keys(v.map)) {
        // Stage 1: the transform decides whether to raise the native catalog price.
        const nativePrice = parseFloat(v.map[priceListId]);
        if (!isFinite(nativePrice)) continue;

        const tFull = transformRun(cartFor(v.gid, v.raw, v.retail, priceListId, 3, nativePrice));
        const tPruned = transformRun(cartFor(v.gid, prunedJson, v.retail, priceListId, 3, nativePrice));
        if (JSON.stringify(tFull) !== JSON.stringify(tPruned)) {
          transformMismatch++;
          if (examples.length < 5) examples.push({ stage: "transform", sku: v.sku, priceListId, tFull, tPruned });
        }

        // Stage 2: the discount runs on whatever price the transform left behind.
        const raised = tFull.operations?.[0]?.update?.price?.adjustment?.fixedPricePerUnit?.amount;
        const linePrice = raised ? parseFloat(raised) : nativePrice;

        const dFull = discountRun(cartFor(v.gid, v.raw, v.retail, priceListId, 3, linePrice));
        const dPruned = discountRun(cartFor(v.gid, prunedJson, v.retail, priceListId, 3, linePrice));
        if (JSON.stringify(dFull) !== JSON.stringify(dPruned)) {
          discountMismatch++;
          if (examples.length < 5) examples.push({ stage: "discount", sku: v.sku, priceListId, dFull, dPruned });
        }
        cases++;
      }
    }

    console.log(`\nvariant x catalog cases: ${cases}`);
    console.log(`transform output differences: ${transformMismatch}`);
    console.log(`discount output differences:  ${discountMismatch}`);
    console.log(`price map bytes: ${(bytesFull / 1024).toFixed(0)} KB -> ${(bytesPruned / 1024).toFixed(0)} KB`);
    if (examples.length) console.error("MISMATCHES:", JSON.stringify(examples, null, 2));

    expect(transformMismatch).toBe(0);
    expect(discountMismatch).toBe(0);
  }, 300000);
});
