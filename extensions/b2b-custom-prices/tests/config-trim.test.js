// Proves trimming the deal config changes no prices.
//
// The config sits in the Function's input on every cart, and in that runtime
// JSON.parse cost scales with the number of keys, so the copy the Function
// reads carries only the five fields it actually uses. That is only safe if the
// output is bit-identical, which is what this asserts -- against the live
// config, every variant it names, and both transform states.
import fs from "fs";
import path from "path";
import { describe, test, expect } from "vitest";
import { run } from "../src/run.js";

const DATA = process.env.AUDIT_DATA_DIR;
const loadJsonl = (f) =>
  fs.readFileSync(path.join(DATA, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Must match FUNCTION_FIELDS in app/routes/app.bogo.jsx.
const FUNCTION_FIELDS = ["buyQty", "getQty", "variantIds", "catalogIds", "overridePct"];
const trim = (bundle) => {
  const out = {};
  for (const f of FUNCTION_FIELDS) if (bundle?.[f] !== undefined) out[f] = bundle[f];
  return out;
};

describe("trimmed deal config", () => {
  const full = fs.readFileSync(path.join(DATA, "bogo_bundles.json"), "utf8");
  const bundles = JSON.parse(full);
  const trimmed = JSON.stringify(bundles.map(trim));

  test("is genuinely smaller", () => {
    expect(trimmed.length).toBeLessThan(full.length * 0.6);
    // Nothing the Functions read may be dropped.
    for (let i = 0; i < bundles.length; i++) {
      const t = JSON.parse(trimmed)[i];
      for (const f of FUNCTION_FIELDS) {
        expect(t[f]).toEqual(bundles[i][f]);
      }
    }
  });

  test("prices every deal variant identically, in every catalog, both transform states", () => {
    const dealIds = new Set(bundles.flatMap((b) => b.variantIds ?? []));
    const variants = loadJsonl("variants.jsonl").filter(
      (v) => v.id && dealIds.has(v.id) && v.fixedPrices?.value && v.standardRetail?.value
    );
    expect(variants.length).toBeGreaterThan(10);

    let carts = 0;
    const diffs = [];

    for (const v of variants) {
      let map;
      try { map = JSON.parse(v.fixedPrices.value); } catch { continue; }
      const retail = parseFloat(v.standardRetail.value);

      for (const priceListId of Object.keys(map)) {
        const catalog = parseFloat(map[priceListId]);
        if (!isFinite(catalog)) continue;
        for (const cost of [retail, catalog]) {
          // Quantities either side of every deal threshold.
          for (const qty of [1, 5, 6, 10, 11, 20, 22, 40]) {
            const mk = (bogoValue) => ({
              discountNode: { bogoBundles: { value: bogoValue } },
              cart: {
                buyerIdentity: {
                  purchasingCompany: {
                    company: { priceListId: { value: priceListId }, discountPct: { value: "0" } },
                  },
                },
                lines: [{
                  id: "gid://shopify/CartLine/1",
                  quantity: qty,
                  cost: { amountPerQuantity: { amount: String(cost) } },
                  merchandise: {
                    __typename: "ProductVariant", id: v.id,
                    fixedPrices: { value: v.fixedPrices.value },
                    standardRetail: { value: v.standardRetail.value },
                  },
                }],
              },
            });
            const a = JSON.stringify(run(mk(full)));
            const b = JSON.stringify(run(mk(trimmed)));
            if (a !== b) {
              diffs.push(`${v.id} ${priceListId} cost${cost} qty${qty}\n  full: ${a}\n  trim: ${b}`);
            }
            carts++;
          }
        }
      }
    }

    console.log(`\ncarts compared: ${carts}   output differences: ${diffs.length}`);
    if (diffs.length) console.error(diffs.slice(0, 5));
    expect(diffs).toEqual([]);
  }, 300000);

  test("multi-line deal carts are identical too", () => {
    const dealIds = [...new Set(bundles.flatMap((b) => b.variantIds ?? []))];
    const byId = new Map();
    for (const v of loadJsonl("variants.jsonl")) {
      if (v.id && v.fixedPrices?.value && v.standardRetail?.value) byId.set(v.id, v);
    }
    const usable = dealIds.map((id) => byId.get(id)).filter(Boolean);
    const GENERAL = "gid://shopify/PriceList/34326708537";

    let carts = 0;
    const diffs = [];
    for (const raised of [true, false]) {
      for (const n of [2, 7, 15, 30]) {
        for (const qty of [1, 6, 11, 22]) {
          const lines = usable.slice(0, n).map((v, i) => {
            const map = JSON.parse(v.fixedPrices.value);
            const cat = map[GENERAL] !== undefined ? parseFloat(map[GENERAL]) : parseFloat(v.standardRetail.value);
            return {
              id: `gid://shopify/CartLine/${i}`,
              quantity: qty,
              cost: { amountPerQuantity: { amount: String(raised ? parseFloat(v.standardRetail.value) : cat) } },
              merchandise: {
                __typename: "ProductVariant", id: v.id,
                fixedPrices: { value: v.fixedPrices.value },
                standardRetail: { value: v.standardRetail.value },
              },
            };
          });
          if (!lines.length) continue;
          const mk = (bogoValue) => ({
            discountNode: { bogoBundles: { value: bogoValue } },
            cart: {
              buyerIdentity: { purchasingCompany: { company: { priceListId: { value: GENERAL }, discountPct: { value: "0" } } } },
              lines: structuredClone(lines),
            },
          });
          const a = JSON.stringify(run(mk(full)));
          const b = JSON.stringify(run(mk(trimmed)));
          if (a !== b) diffs.push(`raised${raised}/n${n}/qty${qty}`);
          carts++;
        }
      }
    }
    console.log(`multi-line carts compared: ${carts}   differences: ${diffs.length}`);
    expect(diffs).toEqual([]);
  }, 300000);
});
