// Multi-device simulator for the shared cart.
//
// Runs the REAL theme script (snippets/drusk-shared-cart.liquid in the theme
// repo) on N virtual devices inside Node's vm, against
//   - a model of Shopify's per-browser cart (cart.js / add / change / update /
//     clear, FIFO per cart, ~2.5 s per write as measured on this store, stock
//     limits, quantity rules), and
//   - the REAL server code (readState / writeState / sanitizeLines and the
//     real live-stream channel), with an in-memory database.
// Time is virtual, so a 30 minute session runs in about a second.
//
// Usage lives in shared-cart-sim.test.js.
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";

const THEME_SNIPPET = process.env.DRUSK_THEME_SNIPPET || `${os.homedir()}/WorthyProductsSouthWebsite/snippets/drusk-shared-cart.liquid`;

export function loadThemeScript(locId = 18276548921, customerId = 9340082585913) {
  const src = fs.readFileSync(THEME_SNIPPET, "utf8");
  const a = src.indexOf("<script>") + "<script>".length;
  const b = src.lastIndexOf("</script>");
  return src.slice(a, b).split("{{ drusk_loc.id | json }}").join(JSON.stringify(locId)).split("{{ customer.id | json }}").join(JSON.stringify(customerId));
}

// ── virtual clock ────────────────────────────────────────────────────────────
export class Clock {
  constructor() { this.now = 1_700_000_000_000; this.q = []; this.seq = 0; this.cancelled = new Set(); }
  at(delay, fn) { const id = ++this.seq; this.q.push({ t: this.now + Math.max(0, delay), id, fn }); return id; }
  cancel(id) { this.cancelled.add(id); }
  async flush() { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); }
  async run(ms) {
    const end = this.now + ms;
    let n = 0, stuckAt = this.now, stuckN = 0;
    for (;;) {
      this.q.sort((x, y) => x.t - y.t || x.id - y.id);
      if (!this.q.length || this.q[0].t > end) break;
      const e = this.q.shift();
      this.now = e.t;
      if (this.cancelled.has(e.id)) continue;
      if (this.now === stuckAt) { if (++stuckN > 5000) throw new Error("virtual clock stuck at t=" + (this.now - 1_700_000_000_000) + "ms: >5000 events at the same instant (zero-delay loop)"); } else { stuckAt = this.now; stuckN = 0; }
      if (++n > 400000) throw new Error("too many events (" + n + ")");
      e.fn();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
}

// Deterministic randomness so a failing run can be replayed.
export function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// ── Shopify's cart for one browser ───────────────────────────────────────────
export class ShopifyCart {
  constructor(clock, rnd, { writeMs = 2500, readMs = 250, stock = {}, rules = {} } = {}) {
    this.clock = clock; this.rnd = rnd; this.lines = []; this.nextKey = 1; this.busyUntil = 0;
    this.writeMs = writeMs; this.readMs = readMs; this.stock = stock; this.rules = rules; this.log = [];
  }
  jitter(ms) { return Math.round(ms * (0.7 + this.rnd() * 0.6)); }
  // Cart writes are serialised per cart and slow (the wholesale pricing rules).
  enqueue(kind, work) {
    return new Promise((resolve) => {
      const dur = kind === "read" ? this.jitter(this.readMs) : this.jitter(this.writeMs);
      const start = Math.max(this.clock.now, this.busyUntil);
      this.busyUntil = start + dur;
      this.clock.at(start + dur - this.clock.now, () => resolve(work()));
    });
  }
  limit(variantId, qty) {
    const s = this.stock[variantId];
    let q = s === undefined ? qty : Math.min(qty, s);
    const r = this.rules[variantId];
    if (r && r.increment > 1) q = Math.floor(q / r.increment) * r.increment;
    return q;
  }
  json() {
    const items = this.lines.map((l) => ({ key: l.key, id: l.variant_id, variant_id: l.variant_id, quantity: l.quantity, properties: l.properties || {} }));
    return { token: "sim", items, item_count: items.reduce((a, i) => a + i.quantity, 0) };
  }
  find(variantId, props) {
    const k = JSON.stringify(Object.entries(props || {}).sort());
    return this.lines.find((l) => l.variant_id === variantId && JSON.stringify(Object.entries(l.properties || {}).sort()) === k);
  }
  total() { return this.lines.reduce((a, l) => a + l.quantity, 0); }
  byVariant() { const m = {}; for (const l of this.lines) m[l.variant_id] = (m[l.variant_id] || 0) + l.quantity; return m; }
  handle(url, body) {
    if (/^\/cart\.js/.test(url)) return this.enqueue("read", () => ({ status: 200, body: this.json() }));
    if (/^\/cart\/add/.test(url)) {
      return this.enqueue("write", () => {
        for (const it of body.items) {
          const props = it.properties || {};
          const ex = this.find(it.id, props);
          const want = (ex ? ex.quantity : 0) + it.quantity;
          const q = this.limit(it.id, want);
          if (q <= (ex ? ex.quantity : 0) && q < want && this.stock[it.id] !== undefined && this.stock[it.id] <= 0) return { status: 422, body: { status: 422, message: "sold out" } };
          if (ex) ex.quantity = q; else this.lines.push({ key: `k${this.nextKey++}`, variant_id: it.id, quantity: q, properties: props });
        }
        return { status: 200, body: { items: body.items } };
      });
    }
    if (/^\/cart\/change/.test(url)) {
      return this.enqueue("write", () => {
        const l = this.lines.find((x) => x.key === body.id || x.variant_id === body.id);
        if (!l) return { status: 200, body: this.json() };
        const q = this.limit(l.variant_id, body.quantity);
        if (body.quantity <= 0) this.lines = this.lines.filter((x) => x !== l); else l.quantity = q;
        return { status: 200, body: this.json() };
      });
    }
    if (/^\/cart\/update/.test(url)) {
      return this.enqueue("write", () => {
        // Shopify accepts update keys that are a LINE KEY (a string like "k3") or a variant id
        // (which reaches the FIRST line of that variant only).
        const target = (k) => { const byKey = this.lines.find((x) => x.key === k); return byKey ? { line: byKey, id: byKey.variant_id } : { line: this.lines.find((x) => x.variant_id === Number(k)), id: Number(k) }; };
        // A sold-out variant fails the WHOLE request.
        for (const [k, qty] of Object.entries(body.updates || {})) {
          const t = target(k); const s = this.stock[t.id];
          if (s !== undefined && s <= 0 && qty > 0 && !t.line) return { status: 422, body: { status: 422, message: "sold out" } };
        }
        for (const [k, qty] of Object.entries(body.updates || {})) {
          const t = target(k);
          if (qty <= 0) { if (t.line) this.lines = this.lines.filter((x) => x !== t.line); continue; }
          if (t.line) t.line.quantity = this.limit(t.id, qty);
          else if (Number.isFinite(t.id)) { const q = this.limit(t.id, qty); if (q > 0) this.lines.push({ key: `k${this.nextKey++}`, variant_id: t.id, quantity: q, properties: {} }); }
        }
        const j = this.json();
        if (body.sections) j.sections = { "cart-icon-bubble": '<div class="shopify-section"><span>' + j.item_count + "</span></div>" };
        return { status: 200, body: j };
      });
    }
    if (/^\/cart\/clear/.test(url)) return this.enqueue("write", () => { this.lines = []; return { status: 200, body: this.json() }; });
    if (/sections=cart-icon-bubble/.test(url)) return this.enqueue("read", () => ({ status: 200, body: { "cart-icon-bubble": '<div class="shopify-section"><span>x</span></div>' } }));
    return Promise.resolve({ status: 404, body: {} });
  }
}

// ── the app server (real code, in-memory db) ─────────────────────────────────
export class AppServer {
  constructor(clock, rnd, mods, { latencyMs = 280 } = {}) {
    this.clock = clock; this.rnd = rnd; this.m = mods; this.latencyMs = latencyMs;
    this.posts = []; this.gets = 0; this.conflicts = 0; this.saves = 0; this.down = false;
  }
  lat() { return Math.round(this.latencyMs * (0.6 + this.rnd() * 0.8)); }
  async handle(method, url, body, key) {
    const u = new URL(url, "https://x");
    const { readState, writeState, sanitizeLines } = this.m;
    if (method === "GET") {
      this.gets++;
      const state = await readState("shop", key);
      const known = u.searchParams.get("known");
      if (known !== null && Number(known) === state.v) return { status: 200, body: { enabled: true, v: state.v, unchanged: true } };
      if (u.searchParams.get("stream") === "1") return { status: 200, body: { enabled: true, ...state, streamUrl: "sim://stream" } };
      return { status: 200, body: { enabled: true, ...state } };
    }
    const lines = sanitizeLines(body.lines);
    const res = await writeState("shop", key, { lines, by: "sim" }, body.baseVersion);
    this.posts.push({ t: this.clock.now, ok: res.ok, v: res.state.v, lines: lines.length });
    if (!res.ok) { this.conflicts++; return { status: 409, body: { conflict: true, ...res.state } }; }
    this.saves++;
    return { status: 200, body: { ok: true, ...res.state } };
  }
}

// ── one browser running the real theme script ───────────────────────────────
export class Device {
  constructor(name, { clock, rnd, server, key, script, cart, stream = true, path = "/collections/x", mods }) {
    Object.assign(this, { name, clock, rnd, server, key, script, cart, stream, path, mods });
    this.localStorage = new Map(); this.sessionStorage = new Map(); this.reloads = 0; this.notices = 0;
    this.requests = []; this.visible = true; this.unsubscribe = null; this.boot();
  }
  boot() {
    const dev = this, clock = this.clock;
    const store = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
    const timers = new Set();
    this.timers = timers;
    const bubble = { _h: "", set innerHTML(v) { this._h = v; dev.bubbleUpdates = (dev.bubbleUpdates || 0) + 1; }, get innerHTML() { return this._h; } };
    const doc = {
      readyState: "complete", activeElement: null, body: { appendChild: () => { dev.notices++; } },
      get visibilityState() { return dev.visible ? "visible" : "hidden"; },
      createElement: () => ({ setAttribute() {}, style: {}, remove() {}, set textContent(v) {} }),
      querySelector: () => null, getElementById: (id) => (id === "cart-icon-bubble" ? bubble : null),
      addEventListener: (ev, fn) => { if (ev === "visibilitychange") dev.onVisibility = fn; },
    };
    let observer = null;
    class PerformanceObserver { constructor(cb) { observer = cb; } observe() {} }
    dev.notifyResource = (url) => { if (observer) observer({ getEntries: () => [{ name: url }] }); };
    class EventSource {
      constructor(url) {
        this.closed = false; this.url = url; const es = this;
        clock.at(120, () => { if (!es.closed && es.onopen) es.onopen(); });
        dev.unsubscribe = dev.mods.subscribe(dev.mods.channelKey("shop", dev.key), (msg) => {
          clock.at(80 + Math.round(dev.rnd() * 120), () => { if (!es.closed && es.onmessage) es.onmessage({ data: JSON.stringify(msg) }); });
        });
      }
      close() { this.closed = true; if (dev.unsubscribe) dev.unsubscribe(); }
    }
    if (!this.stream) EventSource = undefined;
    const fetchImpl = (url, opts = {}) => {
      const method = opts.method || "GET";
      const body = opts.body ? JSON.parse(opts.body) : null;
      dev.requests.push({ t: clock.now, method, url: url.split("?")[0] });
      const isCart = /^\/cart/.test(url) || /^\?sections/.test(url);
      let p;
      if (url.startsWith("/apps/dr-account/shared-cart")) {
        p = new Promise((resolve) => clock.at(dev.server.lat(), async () => {
          if (dev.server.down) return resolve({ status: 502, body: "bad gateway" });
          resolve(await dev.server.handle(method, url, body, dev.key));
        }));
      } else p = dev.cart.handle(url.startsWith("?") ? "/" + url : url, body);
      return p.then((r) => {
        if (/\/cart\/(add|change|update|clear)(\.js)?(\?|$)/.test(url)) dev.notifyResource(location.origin + url);
        return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
      });
    };
    const location = { origin: "https://b2b.dutchrusk.co.nz", pathname: this.path, reload: () => { dev.reloads++; clock.at(900, () => dev.shutdown() || dev.boot()); } };
    const wrapTimer = (fn, ms, repeat) => {
      let id; const wrap = () => { if (repeat) id2 = clock.at(ms, wrap); fn(); };
      let id2 = clock.at(ms, wrap); timers.add(() => clock.cancel(id2)); return { cancel: () => clock.cancel(id2) };
    };
    const handles = new Map(); let hid = 0;
    const ctx = vm.createContext({
      document: doc, location, localStorage: store(this.localStorage), sessionStorage: store(this.sessionStorage), fetch: fetchImpl,
      PerformanceObserver, EventSource, console: { log() {}, warn() {}, error() {} },
      DOMParser: class { parseFromString() { return { querySelector: () => ({ innerHTML: "<span></span>" }) }; } },
      Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } },
      setTimeout: (fn, ms) => { const h = ++hid; const w = wrapTimer(fn, ms || 0, false); handles.set(h, w); return h; },
      clearTimeout: (h) => { const w = handles.get(h); if (w) w.cancel(); },
      setInterval: (fn, ms) => { const h = ++hid; const w = wrapTimer(fn, ms, true); handles.set(h, w); return h; },
      clearInterval: (h) => { const w = handles.get(h); if (w) w.cancel(); },
    });
    ctx.window = ctx;
    this.ctx = ctx;
    vm.runInContext(this.script, ctx);
  }
  shutdown() { for (const c of this.timers) c(); if (this.unsubscribe) this.unsubscribe(); return false; }

  // what a person does (these are the theme's own cart calls, noticed by the observer)
  async fetchRaw(url, body) {
    return this.ctx.fetch(url, { method: "POST", body: JSON.stringify(body) });
  }
  add(variantId, quantity = 1, properties) { return this.fetchRaw("/cart/add.js", { items: [{ id: variantId, quantity, ...(properties ? { properties } : {}) }] }); }
  async setQty(variantId, quantity) {
    const c = await (await this.ctx.fetch("/cart.js")).json();
    const l = c.items.find((i) => i.variant_id === variantId);
    if (!l) return null;
    return this.fetchRaw("/cart/change.js", { id: l.key, quantity });
  }
  remove(variantId) { return this.setQty(variantId, 0); }
  clear() { return this.fetchRaw("/cart/clear.js", {}); }
  setVisible(v) { this.visible = v; if (v && this.onVisibility) this.onVisibility(); }
  state() { return this.cart.byVariant(); }
}

// ── in-memory prisma + wiring of the real server modules ────────────────────
export function makeFakePrisma() {
  const rows = new Map();
  const k = (w) => `${w.shop}|${w.locationGid}`;
  return {
    rows,
    sharedCart: {
      findUnique: async ({ where }) => { const r = rows.get(k(where.shop_locationGid)); return r ? { ...r } : null; },
      create: async ({ data }) => { const key = k(data); if (rows.has(key)) { const e = new Error("dup"); e.code = "P2002"; throw e; } const r = { ...data, updatedAt: new Date() }; rows.set(key, r); return { ...r }; },
      updateMany: async ({ where, data }) => { const r = rows.get(k(where)); if (!r || r.version !== where.version) return { count: 0 }; r.version += data.version.increment; r.lines = data.lines; r.updatedBy = data.updatedBy; r.updatedAt = new Date(); return { count: 1 }; },
    },
  };
}
