// Run: node --test app/lib/volume-breaks.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tierSuffix, breaksSnapshot, parseSnapshot, changedVariants } from "./volume-breaks.server.js";

test("Metromart Bic Lighters Outer: retail 80, base 61.20, 12+ at 47.83", () => {
  assert.equal(tierSuffix(80, 61.2, [{ min: 12, price: 47.83 }]), "@12=32.17");
});
test("several breaks, any order, sorted by quantity", () => {
  assert.equal(tierSuffix(80, 61.2, [{ min: 24, price: 44 }, { min: 12, price: 47.83 }]), "@12=32.17@24=36.00");
});
test("a break at or above the base price is dropped", () => {
  assert.equal(tierSuffix(80, 61.2, [{ min: 12, price: 61.2 }, { min: 24, price: 70 }]), "");
});
test("quantity 1 or nonsense is dropped", () => {
  assert.equal(tierSuffix(80, 61.2, [{ min: 1, price: 50 }, { min: 0, price: 50 }, { min: "x", price: 50 }, { min: 12, price: "y" }, { min: 12, price: -1 }]), "");
  assert.equal(tierSuffix(80, 61.2, undefined), "");
  assert.equal(tierSuffix(80, 61.2, []), "");
  assert.equal(tierSuffix(0, 61.2, [{ min: 12, price: 47 }]), "");
});
test("two breaks at the same quantity: the lower price wins", () => {
  assert.equal(tierSuffix(80, 61.2, [{ min: 12, price: 50 }, { min: 12, price: 47.83 }]), "@12=32.17");
});
test("the Shipper mistake: 12+ at $47.83 on a $734.40 case is rejected and reported", () => {
  const skipped = [];
  assert.equal(tierSuffix(960, 734.4, [{ min: 12, price: 47.83 }], (s) => skipped.push(s)), "");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].price, 47.83);
});
test("a 30% break is accepted, a 41% one is not", () => {
  assert.equal(tierSuffix(100, 100 - 5, [{ min: 5, price: 66.5 }]), "@5=33.50");
  assert.equal(tierSuffix(100, 95, [{ min: 5, price: 56 }]), "");
});
test("the old Function still reads the base saving: parseFloat stops at the @", () => {
  const entry = "18.80" + tierSuffix(80, 61.2, [{ min: 12, price: 47.83 }]);
  assert.equal(parseFloat(entry), 18.8);
});
test("snapshot round trip and change detection", () => {
  const live = { "gid://v/1": [{ min: 12, price: 47.83 }, { min: 24, price: 44 }] };
  const snap = breaksSnapshot(live);
  assert.deepEqual(snap, { "gid://v/1": "12=47.83;24=44.00" });
  assert.deepEqual(parseSnapshot(snap), live);
  assert.deepEqual(changedVariants(snap, snap), []);
  assert.deepEqual(changedVariants(snap, {}), ["gid://v/1"]); // removed
  assert.deepEqual(changedVariants({}, snap), ["gid://v/1"]); // added
  assert.deepEqual(changedVariants(snap, { "gid://v/1": "12=45.00;24=44.00" }), ["gid://v/1"]); // changed
});

import { tierFlag } from "./volume-breaks.server.js";
test("the + flag appears only when some price list entry has a break", () => {
  assert.equal(tierFlag({ "111": "18.80@12=32.17" }), "+");
  assert.equal(tierFlag({ "111": "18.80", "222": "5.00@5=9.00" }), "+");
  assert.equal(tierFlag({ "111": "18.80", "222": "5.00" }), "");
  assert.equal(tierFlag({}), "");
});
