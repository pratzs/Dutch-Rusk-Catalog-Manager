// Run: node --test app/lib/bogo-schedule.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { isActiveIn, nzMonth, parseMonths, describeSchedule } from "./bogo-schedule.server.js";
import { desiredOrder } from "./brand-order.server.js";

test("no schedule = all year (Dragon, Bundaberg)", () => {
  assert.equal(isActiveIn({ id: "dragon-2kg-5-1" }, "2026-10"), true);
  assert.equal(isActiveIn({ id: "bundaberg-6-1", months: null }, "2027-03"), true);
});
test("a month list is exact; an empty list is off", () => {
  assert.equal(isActiveIn({ months: ["2026-09"] }, "2026-09"), true);
  assert.equal(isActiveIn({ months: ["2026-09"] }, "2026-10"), false);
  assert.equal(isActiveIn({ months: [] }, "2026-10"), false);
});
test("the month turns at midnight New Zealand time, not UTC", () => {
  assert.equal(nzMonth(new Date("2026-10-31T10:59:00Z")), "2026-10"); // 23:59 NZDT on the 31st
  assert.equal(nzMonth(new Date("2026-10-31T11:00:00Z")), "2026-11"); // 00:00 NZDT on 1 Nov
  assert.equal(nzMonth(new Date("2026-06-30T11:59:00Z")), "2026-06"); // NZST
  assert.equal(nzMonth(new Date("2026-06-30T12:00:00Z")), "2026-07");
});
test("months input", () => {
  assert.equal(parseMonths(""), null);
  assert.equal(parseMonths("  "), null);
  assert.deepEqual(parseMonths("2026-11, 2026-10 2026-11"), ["2026-10", "2026-11"]);
  assert.throws(() => parseMonths("Nov 2026"), /not a month/);
  assert.throws(() => parseMonths("2026-13"), /not a month/);
  assert.equal(describeSchedule({}), "All year");
  assert.equal(describeSchedule({ months: ["2026-10"] }), "2026-10");
  assert.match(describeSchedule({ months: [] }), /Off/);
});
test("sold-out products sink to the bottom of the Deals page, in their usual order", () => {
  const p = (id, vendor, title, soldOut) => ({ id, vendor, title, tags: [], soldOut });
  const list = [p("a", "Mars", "A bar", true), p("b", "Mars", "B bar", false), p("c", "Cadbury", "C bar", false), p("d", "Cadbury", "D bar", true)];
  assert.deepEqual(desiredOrder(list, { soldOutLast: true }).map((x) => x.id), ["b", "c", "a", "d"]);
  // off by default, so every other collection is arranged exactly as before
  assert.deepEqual(desiredOrder(list).map((x) => x.id), ["a", "b", "c", "d"]);
});
