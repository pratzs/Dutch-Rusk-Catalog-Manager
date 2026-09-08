// Proves the new Discounts API function prices EXACTLY like the live one.
//
// This is the gate for the migration: if a single cart resolves to a different
// per-unit price, the port is wrong and must not go anywhere near production.
// Both functions are run over the same carts and compared on the only thing
// that matters -- what each unit ends up costing the buyer.
import fs from "fs";
import path from "path";
import { describe, test, expect } from "vitest";
import { run as oldRun } from "../src/run.js";
import { cartLinesDiscountsGenerateRun as newRun } from "../../b2b-catalog-discount/src/cart_lines_discounts_generate_run.js";

const DATA = process.env.AUDIT_DATA_DIR;
const loadJsonl = (f) => fs.readFileSync(path.join(DATA, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Reduce either function's output to { lineId: totalDiscountForThatLine }. */
function totalsFromOld(result) {
  const out = {};
  for (const d of result.discounts ?? []) {
    for (const t of d.targets) {
      const off = parseFloat(d.value.fixedAmount.amount) * t.cartLine.quantity;
      out[t.cartLine.id] = (out[t.cartLine.id] ?? 0) + off;
    }
  }
  return out;
}

function totalsFromNew(result) {
  const out = {};
  for (const op of result.operations ?? []) {
    for (const c of op.productDiscountsAdd?.candidates ?? []) {
      for (const t of c.targets) {
        const off = parseFloat(c.value.fixedAmount.amount) * t.cartLine.quantity;
        out[t.cartLine.id] = (out[t.cartLine.id] ?? 0) + off;
      }
    }
  }
  return out;
}

/** The old function's input shape -> the new function's input shape. */
function toNewInput(oldInput) {
  return {
    discount: { bogoBundles: oldInput.discountNode?.bogoBundles ?? null },
    cart: {
      buyerIdentity: oldInput.cart.buyerIdentity,
      lines: oldInput.cart.lines.map((l) => ({
        id: l.id,
        quantity: l.quantity,
        cost: { amountPerQuantity: { amount: l.cost.amountPerQuantity.amount } },
        merchandise: {
          __typename: l.merchandise.__typename,
          id: l.merchandise.id,
          catalogFixedPrices: l.merchandise.fixedPrices,
          standardRetailPrice: l.merchandise.standardRetail,
        },
      })),
    },
  };
}

function compare(oldInput, label, diffs) {
  const a = totalsFromOld(oldRun(structuredClone(oldInput)));
  const b = totalsFromNew(newRun(structuredClone(toNewInput(oldInput))));
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    const x = a[id] ?? 0;
    const y = b[id] ?? 0;
    if (Math.abs(x - y) > 0.005) diffs.push(`${label} ${id}: old $${x.toFixed(2)} vs new $${y.toFixed(2)}`);
  }
}

describe("new Discounts API function matches the live one", () => {
  const PL = "gid://shopify/PriceList/34326937913";
  const bogo = fs.existsSync(path.join(DATA, "bogo_bundles.json"))
    ? fs.readFileSync(path.join(DATA, "bogo_bundles.json"), "utf8")
    : "[]";

  test("every variant, every catalog, raised and stood-down, with and without deals", () => {
    const variants = [];
    for (const v of loadJsonl("variants.jsonl")) {
      if (!v.id?.includes("ProductVariant")) continue;
      if (!v.fixedPrices?.value || !v.standardRetail?.value) continue;
      let map;
      try { map = JSON.parse(v.fixedPrices.value); } catch { continue; }
      variants.push({ id: v.id, raw: v.fixedPrices.value, retail: parseFloat(v.standardRetail.value), map });
    }
    expect(variants.length).toBeGreaterThan(1000);

    const diffs = [];
    let carts = 0;

    for (const v of variants) {
      for (const priceListId of Object.keys(v.map)) {
        const catalog = parseFloat(v.map[priceListId]);
        if (!isFinite(catalog)) continue;

        // Both states that matter: the transform raised the line (cost=retail)
        // and it stood down (cost=catalog).
        for (const cost of [v.retail, catalog]) {
          // And with the deal config present as well as absent.
          for (const withBogo of [true, false]) {
            const lines = [{
              id: "gid://shopify/CartLine/1",
              quantity: 22, // clears the largest bundle so deals actually fire
              cost: { amountPerQuantity: { amount: String(cost) } },
              merchandise: {
                __typename: "ProductVariant", id: v.id,
                fixedPrices: { value: v.raw },
                standardRetail: { value: String(v.retail) },
              },
            }];
            const oldInput = {
              discountNode: withBogo ? { bogoBundles: { value: bogo } } : {},
              cart: {
                buyerIdentity: { purchasingCompany: { company: { priceListId: { value: priceListId }, discountPct: { value: "0" } } } },
                lines,
              },
            };
            compare(oldInput, `${v.id.split("/").pop()}/${priceListId.split("/").pop()}/cost${cost}/bogo${withBogo}`, diffs);
            carts++;
          }
        }
      }
    }

    console.log(`\ncarts compared: ${carts}`);
    console.log(`price differences: ${diffs.length}`);
    if (diffs.length) console.error(diffs.slice(0, 10));
    expect(diffs).toEqual([]);
  }, 600000);

  test("multi-line deal carts, mixed quantities, both transform states", () => {
    const bundles = JSON.parse(bogo);
    const dealIds = [...new Set(bundles.flatMap((b) => b.variantIds ?? []))];
    const byId = new Map();
    for (const v of loadJsonl("variants.jsonl")) {
      if (v.id && v.fixedPrices?.value && v.standardRetail?.value) byId.set(v.id, v);
    }
    const usable = dealIds.map((id) => byId.get(id)).filter(Boolean);
    expect(usable.length).toBeGreaterThan(10);

    const diffs = [];
    let carts = 0;
    // General Catalog is where the deals are scoped, so exercise that one.
    const GENERAL = "gid://shopify/PriceList/34326708537";

    for (const raised of [true, false]) {
      for (const n of [2, 6, 11, 22, 40]) {
        for (const q of [1, 3, 7, 22]) {
          const lines = usable.slice(0, n).map((v, i) => {
            const map = JSON.parse(v.fixedPrices.value);
            const cat = map[GENERAL] !== undefined ? parseFloat(map[GENERAL]) : parseFloat(v.standardRetail.value);
            return {
              id: `gid://shopify/CartLine/${i}`,
              quantity: q,
              cost: { amountPerQuantity: { amount: String(raised ? parseFloat(v.standardRetail.value) : cat) } },
              merchandise: {
                __typename: "ProductVariant", id: v.id,
                fixedPrices: { value: v.fixedPrices.value },
                standardRetail: { value: v.standardRetail.value },
              },
            };
          });
          if (!lines.length) continue;
          compare({
            discountNode: { bogoBundles: { value: bogo } },
            cart: {
              buyerIdentity: { purchasingCompany: { company: { priceListId: { value: GENERAL }, discountPct: { value: "0" } } } },
              lines,
            },
          }, `deal/raised${raised}/n${n}/q${q}`, diffs);
          carts++;
        }
      }
    }
    console.log(`multi-line deal carts compared: ${carts}   differences: ${diffs.length}`);
    if (diffs.length) console.error(diffs.slice(0, 10));
    expect(diffs).toEqual([]);
  }, 300000);

  // The case the real failing order is: a General Catalog cart that is mostly
  // ordinary product with a handful of deal items mixed in (#1904 is 65 lines
  // with 8). The new function prices those ordinary lines in its first pass and
  // never builds per-line state for them, which is the whole reason a cart that
  // big now fits in the instruction budget -- so the mixture, and the order the
  // two kinds appear in, has to be proven line for line.
  test("mixed carts: deal products alongside ordinary ones, in every arrangement", () => {
    const bundles = JSON.parse(bogo);
    const dealIds = new Set(bundles.flatMap((b) => b.variantIds ?? []));
    const GENERAL = "gid://shopify/PriceList/34326708537";

    const dealVariants = [];
    const plainVariants = [];
    for (const v of loadJsonl("variants.jsonl")) {
      if (!v.id?.includes("ProductVariant")) continue;
      if (!v.fixedPrices?.value || !v.standardRetail?.value) continue;
      (dealIds.has(v.id) ? dealVariants : plainVariants).push(v);
    }
    expect(dealVariants.length).toBeGreaterThan(10);
    expect(plainVariants.length).toBeGreaterThan(100);

    const mkLine = (v, i, q, raised) => {
      let map = {};
      try { map = JSON.parse(v.fixedPrices.value); } catch { /* keep empty */ }
      const retail = parseFloat(v.standardRetail.value);
      const cat = map[GENERAL] !== undefined ? parseFloat(map[GENERAL]) : retail;
      return {
        id: `gid://shopify/CartLine/${i}`,
        quantity: q,
        cost: { amountPerQuantity: { amount: String(raised ? retail : cat) } },
        merchandise: {
          __typename: "ProductVariant", id: v.id,
          fixedPrices: { value: v.fixedPrices.value },
          standardRetail: { value: v.standardRetail.value },
        },
      };
    };

    const diffs = [];
    let carts = 0;

    for (const raised of [true, false]) {
      for (const nDeal of [1, 3, 8, 20]) {
        for (const nPlain of [1, 10, 57, 92]) {
          for (const q of [1, 6, 22]) {
            // Three arrangements, because the first pass emits plain lines as it
            // meets them while deal lines are held back: deals first, deals
            // last, and interleaved.
            const deals = dealVariants.slice(0, nDeal);
            const plains = plainVariants.slice(0, nPlain);

            const arrangements = {
              dealsFirst: [...deals, ...plains],
              dealsLast: [...plains, ...deals],
              interleaved: (() => {
                const out = [];
                const max = Math.max(deals.length, plains.length);
                for (let i = 0; i < max; i++) {
                  if (i < deals.length) out.push(deals[i]);
                  if (i < plains.length) out.push(plains[i]);
                }
                return out;
              })(),
            };

            for (const [label, vs] of Object.entries(arrangements)) {
              const lines = vs.map((v, i) => mkLine(v, i, q, raised));
              compare({
                discountNode: { bogoBundles: { value: bogo } },
                cart: {
                  buyerIdentity: { purchasingCompany: { company: { priceListId: { value: GENERAL }, discountPct: { value: "0" } } } },
                  lines,
                },
              }, `mixed/${label}/raised${raised}/deal${nDeal}/plain${nPlain}/q${q}`, diffs);
              carts++;
            }
          }
        }
      }
    }

    console.log(`mixed carts compared: ${carts}   differences: ${diffs.length}`);
    if (diffs.length) console.error(diffs.slice(0, 10));
    expect(diffs).toEqual([]);
  }, 600000);
});
