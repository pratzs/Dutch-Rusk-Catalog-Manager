// Run: node --test app/lib/catalog-reprice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decideRow, cleanPct } from "./catalog-reprice.server.js";
import { inferBase, endsAtForMonth } from "./deal-sheet.server.js";

test("the worked example: 10% off $31.70 = $28.53, retail -> $33.00 gives $29.70", () => {
  assert.equal(cleanPct(28.53, 31.7), 10);
  const d = decideRow({ retail: 33, fixed: 28.53, compareAt: 31.7 });
  assert.deepEqual([d.action, d.price, d.compareAt, d.pct], ["update", 29.7, 33, 10]);
});
test("retail DOWN follows too", () => {
  const d = decideRow({ retail: 29.5, fixed: 26.55 * 1, compareAt: 29.5 / 1 * 1 });
  assert.equal(d.action, "none"); // already consistent
  const e = decideRow({ retail: 28, fixed: 28.53, compareAt: 31.7 });
  assert.equal(e.price, 25.2);
});
test("consistent rows are left alone", () => {
  assert.equal(decideRow({ retail: 31.7, fixed: 28.53, compareAt: 31.7 }).action, "none");
});
test("Bundaberg case from 5 Oct: 26.55 on 29.50 retail now 31.95 -> 28.76", () => {
  assert.equal(decideRow({ retail: 31.95, fixed: 26.55, compareAt: 29.5 }).price, 28.76);
});
test("15% and 20% steps", () => {
  assert.equal(decideRow({ retail: 100, fixed: 85, compareAt: 90 }).price, 85);
  assert.equal(decideRow({ retail: 110, fixed: 72, compareAt: 90 }).price, 88);
});
test("a negotiated dollar price keeps its price and only refreshes compare-at", () => {
  const d = decideRow({ retail: 33, fixed: 29.1, compareAt: 31.7 }); // 8.2% off, not clean
  assert.deepEqual([d.action, d.price, d.compareAt], ["update", 29.1, 33]);
});
test("a live deal price is never repriced", () => {
  const d = decideRow({ retail: 33, fixed: 55, compareAt: 31.7, dealActive: true });
  assert.deepEqual([d.action, d.price, d.compareAt], ["update", 55, 33]);
  assert.equal(decideRow({ retail: 33, fixed: 55, compareAt: 33, dealActive: true }).action, "none");
});
test("bad data is HELD, not changed", () => {
  assert.equal(decideRow({ retail: 1.13, fixed: 5.76, compareAt: 6.4 }).action, "hold"); // Cocolabu: retail fell 82%
  assert.equal(decideRow({ retail: 376.8, fixed: 25.38, compareAt: 31.4 }).action, "hold"); // Metromart Jack Links
  assert.equal(decideRow({ retail: 100, fixed: 50, compareAt: null }).action, "hold");
  assert.equal(decideRow({ retail: 0, fixed: 5, compareAt: 5 }).action, "hold");
});
test("no compare-at: add it when discounted, ignore when the price equals retail", () => {
  assert.deepEqual(Object.values(decideRow({ retail: 10, fixed: 9, compareAt: null })).slice(0, 3), ["update", 9, 10]);
  assert.equal(decideRow({ retail: 10, fixed: 10, compareAt: null }).action, "none");
});
test("inferBase: what a deal should go back to", () => {
  assert.deepEqual(inferBase(null), { baseKind: "none", basePct: null, baseCustomPrice: null });
  assert.deepEqual(inferBase({ price: 32.36, compareAt: 35.95 }), { baseKind: "pct", basePct: 10, baseCustomPrice: null });
  assert.equal(inferBase({ price: 10, compareAt: 10 }).baseKind, "none");
  assert.deepEqual(inferBase({ price: 29.1, compareAt: 31.7 }), { baseKind: "custom", basePct: null, baseCustomPrice: 29.1 });
});
test("deals end at 00:00 NZ on the 1st (NZDT in Oct/Nov, NZST in Jul)", () => {
  assert.equal(endsAtForMonth("2026-10").toISOString(), "2026-10-31T11:00:00.000Z");
  assert.equal(endsAtForMonth("2026-11").toISOString(), "2026-11-30T11:00:00.000Z");
  assert.equal(endsAtForMonth("2026-12").toISOString(), "2026-12-31T11:00:00.000Z");
  assert.equal(endsAtForMonth("2026-06").toISOString(), "2026-06-30T12:00:00.000Z");
});

test("a held row comes back by itself once Ostendo retail is fixed (remembered compare-at fed back in)", () => {
  // Chupa Chups Bag: price 3.29, remembered compare-at 3.66 (10% off), retail wrongly 5.08 -> held.
  assert.equal(decideRow({ retail: 5.08, fixed: 3.29, compareAt: 3.66 }).action, "hold");
  // Retail corrected to 3.66: consistent again, nothing to reprice.
  assert.equal(decideRow({ retail: 3.66, fixed: 3.29, compareAt: 3.66 }).action, "none");
  // Retail corrected to a nearby value: the same 10% comes back.
  const d = decideRow({ retail: 3.7, fixed: 3.29, compareAt: 3.66 });
  assert.deepEqual([d.action, d.price, d.compareAt, d.pct], ["update", 3.33, 3.7, 10]);
});
