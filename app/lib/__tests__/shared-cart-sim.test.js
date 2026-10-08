// Two-device simulation of the shared cart, running the real theme script.
// See sim-harness.js. Time is virtual (a 30 minute session runs in a second).
//
//   DRUSK_THEME_SNIPPET=<path to drusk-shared-cart.liquid> npx vitest run app/lib/__tests__/shared-cart-sim.test.js
//
// Written to reproduce the Hamish Williams cart report (8 Oct 2026): the same
// product on two cart lines that look identical to the sync (one carries a
// blank line-item property) made two devices re-save every 2 seconds forever.
import { describe, it, expect, vi } from "vitest";
import { Clock, rng, ShopifyCart, AppServer, Device, makeFakePrisma, loadThemeScript } from "./sim-harness.js";

const fake = makeFakePrisma();
vi.mock("../admin-token.server.js", () => ({ getAdminToken: vi.fn() }));
vi.mock("../../db.server.js", () => ({ default: fake }));

const mods = { ...(await import("../shared-cart.server.js")), ...(await import("../shared-cart-events.server.js")) };
const KEY = "gid://shopify/CompanyLocation/18276548921|customer/9340082585913";
const script = loadThemeScript(18276548921, 9340082585913);

const DRAGON = [51043923132729, 43639524950329, 43639525409081, 43639525376313, 47469497450809, 43639517839673];

function world({ seed = 1, stream = true, stock = {}, rules = {}, writeMs = 2500, paths = ["/collections/x", "/collections/x"] } = {}) {
  fake.rows.clear();
  const clock = new Clock();
  const rnd = rng(seed);
  const server = new AppServer(clock, rnd, mods);
  const devices = paths.map((path, i) => new Device(i ? "phone" : "pc", { clock, rnd, server, key: KEY, script, mods, stream, path, cart: new ShopifyCart(clock, rnd, { stock, rules, writeMs }) }));
  return { clock, rnd, server, devices };
}
const serverCart = () => { const r = fake.rows.get("shop|" + KEY); const m = {}; for (const l of r?.lines ?? []) m[l.id] = (m[l.id] || 0) + l.q; return m; };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const eq = (x, y) => JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());

describe("shared cart, two devices", () => {
  it("quiet baseline: one person adds 6 products over 2 minutes, both devices and the server converge", async () => {
    const { clock, devices, server } = world();
    const [pc, phone] = devices;
    await clock.run(5000);
    for (let i = 0; i < DRAGON.length; i++) { void pc.add(DRAGON[i], 1 + i); await clock.run(15000); }
    await clock.run(120000);
    console.log("BASELINE saves", server.posts.length, "conflicts", server.conflicts, "converged", eq(pc.state(), phone.state()) && eq(serverCart(), pc.state()));
    expect(eq(phone.state(), pc.state())).toBe(true);
    expect(eq(serverCart(), pc.state())).toBe(true);
  }, 60000);

  it("A: rapid add / change / remove on one device: nothing removed comes back", async () => {
    let stuck = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { clock, devices } = world({ seed });
      const [pc, phone] = devices;
      await clock.run(5000);
      void pc.add(DRAGON[0], 4); await clock.run(1500);
      void pc.setQty(DRAGON[0], 1); await clock.run(900);
      void pc.add(DRAGON[1], 12); await clock.run(900);
      void pc.remove(DRAGON[0]); await clock.run(900);
      void pc.remove(DRAGON[1]); await clock.run(90000);
      if (sum(pc.state()) || sum(phone.state()) || sum(serverCart())) stuck++;
    }
    console.log("A rapid add/remove: runs where something came back or got stuck:", stuck, "of 6");
    expect(stuck).toBe(0);
  }, 60000);

  it("B: both devices busy for ~10 minutes with random adds/changes/removes: no inflation, ends in agreement", async () => {
    let worst = 0, notConverged = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const { clock, devices, server, rnd } = world({ seed });
      const [pc, phone] = devices;
      await clock.run(5000);
      let maxQty = 0, maxTotal = 0;
      for (let step = 0; step < 150; step++) {
        const dev = rnd() < 0.5 ? pc : phone; const v = DRAGON[Math.floor(rnd() * DRAGON.length)];
        const r = rnd();
        if (r < 0.5) void dev.add(v, 1 + Math.floor(rnd() * 3));
        else if (r < 0.8) void dev.setQty(v, 1 + Math.floor(rnd() * 6));
        else void dev.remove(v);
        await clock.run(1000 + Math.floor(rnd() * 5000));
        for (const d of devices) { const s = d.state(); maxTotal = Math.max(maxTotal, sum(s)); for (const q of Object.values(s)) maxQty = Math.max(maxQty, q); }
      }
      await clock.run(180000);
      const ok = eq(pc.state(), phone.state()) && eq(pc.state(), serverCart());
      if (!ok) notConverged++;
      worst = Math.max(worst, maxTotal);
      console.log("B seed", seed, "| biggest line", maxQty, "| biggest cart", maxTotal, "units | saves", server.posts.length, "| conflicts", server.conflicts, "| agree at the end:", ok);
    }
    expect(worst).toBeLessThan(80);
    expect(notConverged).toBe(0);
  }, 120000);

  it("C: same product on TWO cart lines, one with a blank line-item property (Hamish's saved cart had this): must settle", async () => {
    let looping = 0;
    for (const seed of [21, 22, 23]) {
      const { clock, devices, server } = world({ seed });
      const [pc, phone] = devices;
      await clock.run(5000);
      void pc.add(DRAGON[0], 2); await clock.run(4000);
      void pc.add(DRAGON[0], 1, { Note: "" }); await clock.run(4000);
      void pc.add(DRAGON[1], 2); await clock.run(4000);
      const series = [];
      for (let m = 0; m < 12; m++) { const before = server.posts.length; await clock.run(60000); series.push(server.posts.length - before); }
      const settled = series.slice(-4).every((n) => n === 0);
      if (!settled) looping++;
      console.log("C seed", seed, "| saves per minute, first 3 and last 3:", JSON.stringify([...series.slice(0, 3), "...", ...series.slice(-3)]), "| pc lines", pc.cart.lines.length, "units", pc.cart.total(), "| phone lines", phone.cart.lines.length, "units", phone.cart.total(), "| server", JSON.stringify(serverCart()), "| settled:", settled, "agree:", eq(pc.state(), phone.state()) && eq(pc.state(), serverCart()));
    }
    expect(looping).toBe(0);
  }, 60000);
});

describe("safety brake", () => {
  // Needs a script WITH the brake but WITHOUT the dedupe fix, or the loop never starts:
  //   DRUSK_SIM_BRAKE_ONLY=1 DRUSK_THEME_SNIPPET=<that copy> npx vitest run ... -t "D:"
  it.runIf(process.env.DRUSK_SIM_BRAKE_ONLY)("D: a loop nobody anticipated is cut off: it pauses for minutes at a time and the browser cart keeps working", async () => {
    const { clock, devices, server } = world({ seed: 21 });
    const [pc] = devices;
    await clock.run(5000);
    void pc.add(DRAGON[0], 2); await clock.run(4000);
    void pc.add(DRAGON[0], 1, { Note: "" }); await clock.run(4000); // the Hamish loop, but run on a script WITHOUT the dedupe fix
    const series = [];
    for (let m = 0; m < 12; m++) { const before = server.posts.length; await clock.run(60000); series.push(server.posts.length - before); }
    console.log("D saves per minute over 12 minutes:", JSON.stringify(series), "| cart still works:", sum(pc.state()) > 0);
    expect(series.slice(0, 3).some((n) => n > 10)).toBe(true);      // it did loop at first
    expect(series.filter((n) => n <= 2).length).toBeGreaterThanOrEqual(4); // and the brake silenced it for minutes at a time
    expect(series.reduce((a, b) => a + b, 0) / series.length).toBeLessThan(10); // vs 16 a minute without it
    expect(sum(pc.state())).toBeGreaterThan(0);                      // shopping carried on
  }, 60000);
});
