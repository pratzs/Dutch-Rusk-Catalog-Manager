import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => { process.env.SHOPIFY_API_SECRET = "test-secret"; });

const ev = await import("../shared-cart-events.server.js");

describe("stream token", () => {
  it("round-trips shop and location", () => {
    const t = ev.makeStreamToken("s.myshopify.com", "gid://shopify/CompanyLocation/1");
    expect(ev.readStreamToken(t)).toEqual({ shop: "s.myshopify.com", locationGid: "gid://shopify/CompanyLocation/1" });
  });
  it("rejects a tampered token", () => {
    const t = ev.makeStreamToken("s.myshopify.com", "gid://shopify/CompanyLocation/1");
    const [p, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "s.myshopify.com", l: "gid://shopify/CompanyLocation/2", e: Date.now() + 1e9 })).toString("base64url");
    expect(ev.readStreamToken(`${forged}.${sig}`)).toBeNull();
    expect(ev.readStreamToken(`${p}.${sig}x`)).toBeNull();
    expect(ev.readStreamToken("garbage")).toBeNull();
    expect(ev.readStreamToken(undefined)).toBeNull();
  });
  it("rejects an expired token", () => {
    const t = ev.makeStreamToken("s", "l", Date.now() - 13 * 3600 * 1000);
    expect(ev.readStreamToken(t)).toBeNull();
  });
});

describe("publish", () => {
  it("reaches only devices on the same store, and stops after unsubscribe", () => {
    const got = { a: [], b: [] };
    const offA = ev.subscribe(ev.channelKey("s", "loc1"), (v) => got.a.push(v));
    const offB = ev.subscribe(ev.channelKey("s", "loc2"), (v) => got.b.push(v));
    expect(ev.publish("s", "loc1", 5)).toBe(1);
    offA();
    expect(ev.publish("s", "loc1", 6)).toBe(0);
    expect(got).toEqual({ a: [5], b: [] });
    offB();
    expect(ev.connectionCount()).toBe(0);
  });
  it("one broken connection does not stop the others", () => {
    const got = [];
    const off1 = ev.subscribe(ev.channelKey("x", "y"), () => { throw new Error("dead"); });
    const off2 = ev.subscribe(ev.channelKey("x", "y"), (v) => got.push(v));
    expect(() => ev.publish("x", "y", 9)).not.toThrow();
    expect(got).toEqual([9]);
    off1(); off2();
  });
});
