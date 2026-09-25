import { describe, it, expect, vi } from "vitest";

vi.mock("../admin-token.server.js", () => ({ getAdminToken: vi.fn() }));

const { sanitizeLines, lineKey, mergeLines, shouldClearAfterOrder } = await import("../shared-cart.server.js");

describe("sanitizeLines", () => {
  it("keeps well formed lines", () => {
    expect(sanitizeLines([{ id: 123, q: 2, p: { Note: "x" } }])).toEqual([{ id: 123, q: 2, p: { Note: "x" } }]);
  });

  it("drops anything malformed instead of guessing", () => {
    const out = sanitizeLines([
      { id: "abc", q: 1 },
      { id: -5, q: 1 },
      { id: 10, q: 0 },
      { id: 11, q: "NaN" },
      null,
      { id: 12, q: 3 },
    ]);
    expect(out).toEqual([{ id: 12, q: 3, p: {} }]);
  });

  it("caps quantity, line count and property size", () => {
    expect(sanitizeLines([{ id: 1, q: 999999 }])[0].q).toBe(9999);
    expect(sanitizeLines(Array.from({ length: 400 }, (_, i) => ({ id: i + 1, q: 1 })))).toHaveLength(250);
    const props = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(sanitizeLines([{ id: 1, q: 1, p: props }])[0].p)).toHaveLength(20);
  });

  it("returns nothing for non-arrays", () => {
    expect(sanitizeLines(undefined)).toEqual([]);
    expect(sanitizeLines({ id: 1, q: 1 })).toEqual([]);
  });
});

describe("lineKey", () => {
  it("ignores property order but not property values", () => {
    expect(lineKey({ id: 1, p: { a: "1", b: "2" } })).toBe(lineKey({ id: 1, p: { b: "2", a: "1" } }));
    expect(lineKey({ id: 1, p: { a: "1" } })).not.toBe(lineKey({ id: 1, p: { a: "2" } }));
  });
});

describe("mergeLines", () => {
  it("keeps every line from both devices and the larger quantity", () => {
    const staff = [{ id: 1, q: 5, p: {} }, { id: 2, q: 1, p: {} }];
    const manager = [{ id: 1, q: 3, p: {} }, { id: 3, q: 4, p: {} }];
    const merged = mergeLines(staff, manager).sort((a, b) => a.id - b.id);
    expect(merged).toEqual([
      { id: 1, q: 5, p: {} },
      { id: 2, q: 1, p: {} },
      { id: 3, q: 4, p: {} },
    ]);
  });

  it("never adds quantities together, so a merge cannot double an order", () => {
    const same = [{ id: 1, q: 10, p: {} }];
    expect(mergeLines(same, same)).toEqual([{ id: 1, q: 10, p: {} }]);
  });
});

describe("shouldClearAfterOrder", () => {
  const order = "2026-09-25T02:00:00Z";
  it("clears a cart last edited before the order", () => {
    expect(shouldClearAfterOrder({ lines: [{ id: 1, q: 1 }], at: "2026-09-25T01:59:00Z" }, order)).toBe(true);
  });
  it("keeps a cart someone edited after the order (the next order)", () => {
    expect(shouldClearAfterOrder({ lines: [{ id: 1, q: 1 }], at: "2026-09-25T02:05:00Z" }, order)).toBe(false);
  });
  it("does nothing for an empty or unreadable cart", () => {
    expect(shouldClearAfterOrder({ lines: [], at: "2026-09-25T01:00:00Z" }, order)).toBe(false);
    expect(shouldClearAfterOrder(null, order)).toBe(false);
    expect(shouldClearAfterOrder({ lines: [{ id: 1, q: 1 }], at: "not a date" }, order)).toBe(false);
  });
});
