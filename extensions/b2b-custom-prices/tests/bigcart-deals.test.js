// Deals and volume breaks on carts above 65 lines (16 Nov 2026).
//
// Before this, a cart above 65 lines never got a Buy X Get Y deal and got volume
// breaks on only ten lines. Now the lines that could need either are set aside
// during the budget walk and go through the full deal logic afterwards, but only
// if the budget has room left for all of them. These tests pin:
//
//   1. WHICH lines get a row is exactly what version 294 gave. The walk did not
//      change, so the transform (also unchanged) still agrees line for line.
//   2. Every line is priced either by the full logic or by the plain wholesale
//      row it had before. Nothing in between, nothing new.
//   3. The real orders that missed a deal now get it; a cart with no room is
//      unchanged.
//
// fixtures/run.v294.js           the Function as released in version 294
// fixtures/run.reference-no-limits.js   what each line should cost when cost is
//                                no object (never deployed)
import { describe, test, expect } from "vitest";
import { run as newRun } from "../src/run.js";
import { run as v294Run } from "./fixtures/run.v294.js";
import { run as refRun } from "./fixtures/run.reference-no-limits.js";
import { run as transformRun } from "../../b2b-price-transformer/src/run.js";

let seed = 3304;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const PL = "gid://shopify/PriceList/111";
const DEALS = [
  { i: "dragon-2kg-5-1", b: 5, g: 1, o: 10, c: ["111"] },
  { i: "bundaberg-6-1", b: 6, g: 1, o: 10, c: ["111"] },
  { i: "other-catalog-3-1", b: 3, g: 1, c: ["999"] },
  { i: "everyone-4-1", b: 4, g: 1 },
];

const line = (i, qty, raw) => ({ id: `gid://shopify/CartLine/${i}`, quantity: qty, merchandise: { __typename: "ProductVariant", catSavings: raw === null ? null : { value: raw } } });
const input = (lines, bundles = DEALS) => ({
  discountNode: bundles ? { bogoBundles: { value: JSON.stringify(bundles) } } : {},
  cart: { buyerIdentity: { purchasingCompany: { company: { priceListId: { value: PL } } } }, lines },
});
/** plain line number i with one of `distinct` savings */
const plain = (i, distinct, qty = 1 + (i % 9)) => {
  const sav = (0.5 + (i % distinct) * 0.11).toFixed(2);
  return line(i, qty, `${(parseFloat(sav) * 4).toFixed(2)}|222:0.40|111:${sav}|`);
};
const dragon = (i, qty) => line(i, qty, "20.00|222:2.00|111:4.00|#dragon-2kg-5-1|");

/** line id -> sorted "units@amount:message" rows */
function rows(run, inp) {
  const qty = new Map(inp.cart.lines.map((l) => [l.id, l.quantity]));
  const out = new Map();
  for (const d of run(structuredClone(inp)).discounts ?? []) {
    for (const t of d.targets) {
      const id = t.cartLine.id;
      out.set(id, [...(out.get(id) ?? []), `${t.cartLine.quantity ?? qty.get(id)}@${d.value.fixedAmount.amount}:${d.message}`].sort());
    }
  }
  return out;
}
const asObj = (m) => Object.fromEntries([...m].sort());
const raised = (inp) => new Set((transformRun(structuredClone(inp)).operations ?? []).map((o) => o.update.cartLineId));
const messages = (inp) => new Set((newRun(structuredClone(inp)).discounts ?? []).map((d) => d.message));

function randomCart() {
  const n = 1 + Math.floor(rnd() * 260);
  const distinct = [3, 12, 40, 90, 400][Math.floor(rnd() * 5)];
  const pTag = [0, 0.05, 0.2, 0.6][Math.floor(rnd() * 4)];
  const pFlag = [0, 0.05, 0.3][Math.floor(rnd() * 3)];
  const lines = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.04) { lines.push(line(i, 2, null)); continue; }
    if (r < 0.08) { lines.push(line(i, 2, "9.00|222:1.00|")); continue; }
    const sav = (0.5 + Math.floor(rnd() * distinct) * 0.11).toFixed(2);
    const retail = (parseFloat(sav) * (2 + Math.floor(rnd() * 3))).toFixed(2);
    const flag = rnd() < pFlag;
    const tier = flag ? `@6=${(parseFloat(sav) + 0.3).toFixed(2)}@12=${(parseFloat(sav) + 0.6).toFixed(2)}` : "";
    const tagged = rnd() < pTag;
    const tag = tagged ? `#${["dragon-2kg-5-1", "bundaberg-6-1", "other-catalog-3-1", "everyone-4-1", "dragon-2kg-5-1,everyone-4-1"][Math.floor(rnd() * 5)]}|` : "";
    lines.push(line(i, 1 + Math.floor(rnd() * 14), `${flag ? "+" : ""}${retail}|222:0.40|111:${sav}${tier}|${tag}`));
  }
  return input(lines, rnd() < 0.15 ? null : rnd() < 0.1 ? [] : DEALS);
}

describe("deals and breaks on big carts", { timeout: 240000 }, () => {
  test("the budget covers exactly the lines version 294 covered, and the transform agrees (4000 random carts)", () => {
    let withDeals = 0;
    for (let c = 0; c < 4000; c++) {
      const inp = randomCart();
      const now = rows(newRun, inp);
      const before = rows(v294Run, inp);
      // The covered set is what the (unchanged) transform raises. Neither
      // version may discount a line outside it.
      const up = raised(inp);
      for (const id of now.keys()) expect(up.has(id)).toBe(true);
      for (const id of before.keys()) expect(up.has(id)).toBe(true);
      // On a big cart version 294 gave every covered line a row.
      if (inp.cart.lines.length > 65) expect([...before.keys()].sort()).toEqual([...up].sort());
      // A covered line may end up with no row only the way it can on a small
      // cart: every unit was a deal-paid unit of a deal with no promo price.
      const covered = inp.cart.lines.filter((l) => up.has(l.id));
      const ref = rows(refRun, { ...inp, cart: { ...inp.cart, lines: covered } });
      for (const l of covered) {
        if (now.has(l.id)) continue;
        expect(l.merchandise.catSavings.value.includes("|#")).toBe(true);
        expect(ref.has(l.id)).toBe(false);
      }
      if (inp.cart.lines.length > 65 && [...now.values()].some((r) => r.some((x) => !x.endsWith(":B2B Wholesale Price")))) withDeals++;
    }
    expect(withDeals).toBeGreaterThan(20); // deals really did run on some big carts
  });

  test("every line is priced by the full logic or by its plain wholesale row, never anything else", () => {
    for (let c = 0; c < 2500; c++) {
      const inp = randomCart();
      const n = inp.cart.lines.length;
      if (n <= 65) continue;
      const now = rows(newRun, inp);
      const before = rows(v294Run, inp);
      const covered = inp.cart.lines.filter((l) => before.has(l.id));
      // The reference prices the same lines the budget covered, so that deal
      // quantities are counted over the same set.
      const ref = rows(refRun, { ...inp, cart: { ...inp.cart, lines: covered } });
      const dealRan = [...now.values()].some((r) => r.some((x) => !x.endsWith(":B2B Wholesale Price")));
      for (const l of covered) {
        const got = JSON.stringify(now.get(l.id));
        const raw = l.merchandise.catSavings.value;
        const special = raw.startsWith("+") || raw.includes("|#");
        if (!special) {
          // A plain line is untouched by any of this.
          expect(got).toBe(JSON.stringify(before.get(l.id)));
          expect(got).toBe(JSON.stringify(ref.get(l.id)));
          continue;
        }
        const seg = raw.slice(raw.indexOf("|111:") + 5, raw.indexOf("|", raw.indexOf("|111:") + 1));
        const base = parseFloat(seg);
        // The catalog's own price for this quantity: the deepest break reached.
        let deep = base;
        if (raw.startsWith("+")) for (const m of seg.matchAll(/@(\d+)=([\d.]+)/g)) if (l.quantity >= +m[1] && +m[2] > deep) deep = +m[2];
        const plainRow = JSON.stringify([`${l.quantity}@${base.toFixed(2)}:B2B Wholesale Price`]);
        const breakRow = JSON.stringify([`${l.quantity}@${deep.toFixed(2)}:B2B Wholesale Price`]);
        const full = JSON.stringify(ref.get(l.id));
        // When there is no room for the deal logic, a deal line that also has
        // breaks gets its catalog row: base, or the break while the ten-line
        // allowance lasts.
        expect([plainRow, breakRow, full, JSON.stringify(before.get(l.id))]).toContain(got);
        // If the deal logic ran at all, it ran for every deal line of the cart.
        if (dealRan && raw.includes("|#")) expect(got).toBe(full);
      }
    }
  });

  test("#2980: 68 lines with 7 units of a Buy 6 Get 1 product now gets its free unit", () => {
    const lines = [];
    for (let i = 0; i < 61; i++) lines.push(plain(i, 30));
    for (let i = 61; i < 68; i++) lines.push(line(i, 1, "30.00|111:3.00|#bundaberg-6-1|"));
    const inp = input(lines);
    expect(asObj(rows(newRun, inp))).toEqual(asObj(rows(refRun, inp)));
    const all = [...rows(newRun, inp).values()].flat();
    expect(all.filter((r) => r.endsWith(":Buy X Get Y Free")).length).toBe(1);
    expect([...rows(v294Run, inp).values()].flat().every((r) => r.endsWith(":B2B Wholesale Price"))).toBe(true);
  });

  test("#3304: 102 lines with 11 Dragon 2kg bags gets one bag free, five at the deal price", () => {
    const lines = [];
    for (let i = 0; i < 91; i++) lines.push(plain(i, 49));
    for (let i = 91; i < 102; i++) lines.push(dragon(i, 1));
    const inp = input(lines);
    const now = rows(newRun, inp);
    expect(asObj(now)).toEqual(asObj(rows(refRun, inp)));
    const deal = lines.slice(91).map((l) => now.get(l.id)[0]);
    expect(deal.filter((r) => r === "1@20.00:Buy X Get Y Free").length).toBe(1);
    expect(deal.filter((r) => r === "1@2.00:Deal Price").length).toBe(5);
    expect(deal.filter((r) => r === "1@4.00:B2B Wholesale Price").length).toBe(5);
  });

  test("#2246: 70 lines, 31 of them Dragon bags (41 units), gets six free", () => {
    const lines = [];
    for (let i = 0; i < 39; i++) lines.push(plain(i, 25));
    for (let i = 39; i < 70; i++) lines.push(dragon(i, i < 49 ? 2 : 1));
    const inp = input(lines);
    const now = rows(newRun, inp);
    expect(asObj(now)).toEqual(asObj(rows(refRun, inp)));
    const free = [...now.values()].flat().filter((r) => r.endsWith(":Buy X Get Y Free")).reduce((a, r) => a + parseInt(r, 10), 0);
    expect(free).toBe(6);
  });

  test("a 126-line cart with no room left keeps every row and is priced exactly as in version 294", () => {
    const lines = [];
    for (let i = 0; i < 103; i++) lines.push(plain(i, 51));
    for (let i = 103; i < 126; i++) lines.push(dragon(i, 2));
    const inp = input(lines);
    expect(asObj(rows(newRun, inp))).toEqual(asObj(rows(v294Run, inp)));
    expect(rows(newRun, inp).size).toBe(126);
    expect([...messages(inp)]).toEqual(["B2B Wholesale Price"]);
  });

  test("above 130 lines deals are not attempted; rows are as in version 294", () => {
    const lines = [];
    for (let i = 0; i < 125; i++) lines.push(plain(i, 20));
    for (let i = 125; i < 131; i++) lines.push(dragon(i, 6));
    const inp = input(lines);
    expect(asObj(rows(newRun, inp))).toEqual(asObj(rows(v294Run, inp)));
  });

  test("more than 36 deal lines: deals stand down, every line keeps its plain row", () => {
    const lines = [];
    for (let i = 0; i < 33; i++) lines.push(plain(i, 10));
    for (let i = 33; i < 70; i++) lines.push(dragon(i, 3)); // 37 deal lines
    const inp = input(lines);
    expect(asObj(rows(newRun, inp))).toEqual(asObj(rows(v294Run, inp)));
    expect(rows(newRun, inp).size).toBe(70);
  });

  test("a deal for another catalog changes nothing", () => {
    const lines = [];
    for (let i = 0; i < 64; i++) lines.push(plain(i, 30));
    for (let i = 64; i < 70; i++) lines.push(line(i, 4, "12.00|111:1.20|#other-catalog-3-1|"));
    const inp = input(lines);
    expect(asObj(rows(newRun, inp))).toEqual(asObj(rows(v294Run, inp)));
  });

  test("an 80-line cart with 15 lines that reach a volume break gets the break on all 15, not ten", () => {
    const lines = [];
    for (let i = 0; i < 65; i++) lines.push(plain(i, 30));
    for (let i = 65; i < 80; i++) lines.push(line(i, 12, "+80.00|111:18.80@12=32.17|"));
    const inp = input(lines, null);
    const now = rows(newRun, inp);
    expect(asObj(now)).toEqual(asObj(rows(refRun, inp)));
    expect(lines.slice(65).filter((l) => now.get(l.id)[0] === "12@32.17:B2B Wholesale Price").length).toBe(15);
    const before = rows(v294Run, inp);
    expect(lines.slice(65).filter((l) => before.get(l.id)[0] === "12@32.17:B2B Wholesale Price").length).toBe(10);
  });

  test("a deal id with a '.' four characters from its end is simply not seen as a deal on a big cart", () => {
    const lines = [];
    for (let i = 0; i < 66; i++) lines.push(plain(i, 30));
    lines.push(line(66, 6, "20.00|111:4.00|#odd-5.b1|"));
    const inp = input(lines, [{ i: "odd-5.b1", b: 5, g: 1, o: 10 }]);
    expect(rows(newRun, inp).get("gid://shopify/CartLine/66")).toEqual(["6@4.00:B2B Wholesale Price"]);
  });
});
