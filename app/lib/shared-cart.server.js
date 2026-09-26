// Shared cart per store (company location), so a staff member and their
// manager see the same cart on different devices.
//
// Shopify keeps the online store cart in the browser, not the account, so the
// same login on two devices has two carts. This keeps one copy of the store's
// cart in our database (SharedCart) and the theme syncs each browser's cart
// with it through the app proxy.
//
// Why the database and not a metafield: a metafield read lags a write by a
// second or two (measured in the pilot, 25 Sept 2026), and "add it, then ask
// the manager to refresh" has to work straight away. Postgres returns what was
// just written, and a save is a single conditional UPDATE on `version`, so two
// devices saving at once cannot overwrite each other.
//
// Nobody is affected unless the feature is switched on for them:
//   - shop metafield custom.shared_cart_mode = "all" turns it on everywhere,
//     anything else (or unset) means pilot only
//   - company location metafield custom.shared_cart_enabled = true puts that
//     store in the pilot
// The theme checks the same two values before it loads any of this.

import { getAdminToken } from "./admin-token.server.js";

export const NS = "custom";
export const ENABLED_KEY = "shared_cart_enabled";
export const MODE_KEY = "shared_cart_mode";

const MAX_LINES = 250;
const MAX_QTY = 9999;
const MAX_PROPS = 20;

// ── Pure helpers (tested in __tests__/shared-cart.test.js) ──────────────────

/**
 * Clean untrusted cart lines from the browser. Anything malformed is dropped,
 * never guessed at. Returns [{ id, q, p }] where id is the numeric variant id.
 */
export function sanitizeLines(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input.slice(0, MAX_LINES)) {
    const id = Number(raw?.id);
    const q = Math.floor(Number(raw?.q));
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (!Number.isFinite(q) || q < 1) continue;
    const p = {};
    if (raw?.p && typeof raw.p === "object" && !Array.isArray(raw.p)) {
      for (const [k, v] of Object.entries(raw.p).slice(0, MAX_PROPS)) {
        if (typeof k === "string" && k.length <= 100 && (typeof v === "string" || typeof v === "number")) {
          p[k] = String(v).slice(0, 500);
        }
      }
    }
    out.push({ id, q: Math.min(q, MAX_QTY), p });
  }
  return out;
}

/** Stable key for a line: variant plus its properties. */
export function lineKey(line) {
  const props = Object.keys(line.p || {}).sort().map((k) => [k, line.p[k]]);
  return `${line.id}|${JSON.stringify(props)}`;
}

/**
 * Merge two carts when both devices changed since they last agreed. Keeps
 * every line from either side and takes the larger quantity where both have
 * it, so nothing anyone added is lost and nothing is ever doubled.
 */
export function mergeLines(a, b) {
  const byKey = new Map();
  for (const line of [...a, ...b]) {
    const k = lineKey(line);
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, q: Math.max(prev.q, line.q) } : { ...line });
  }
  return [...byKey.values()];
}

/**
 * After an order, clear the store's shared cart only if nobody has touched it
 * since the order was placed. A later edit means someone has started the next
 * order, which must not be thrown away.
 */
export function shouldClearAfterOrder(state, orderCreatedAt) {
  if (!state || !Array.isArray(state.lines) || state.lines.length === 0) return false;
  const edited = Date.parse(state.at || 0);
  const ordered = Date.parse(orderCreatedAt || 0);
  if (!Number.isFinite(edited) || !Number.isFinite(ordered)) return false;
  return edited <= ordered;
}

/**
 * Only an order placed through the online store checkout came from a shared
 * cart. A draft order a rep keys in for the same store must never empty the
 * cart the customer is building (drafts #2221 and #2241 were placed while
 * customers could have had carts open).
 */
export function isStorefrontOrder(order) {
  return order?.source_name === "web";
}

export function emptyState() {
  return { v: 0, lines: [], at: null, by: null };
}

function toState(row) {
  if (!row) return emptyState();
  return { v: row.version, lines: sanitizeLines(row.lines), at: row.updatedAt?.toISOString?.() ?? null, by: row.updatedBy ?? null };
}

// ── Which store, and is it switched on ──────────────────────────────────────

// Devices poll every few seconds, so the customer-to-location lookup (an
// Admin API call) is cached briefly. A store switched on or off takes effect
// within a minute.
const LOCATION_TTL_MS = 60_000;
const locationCache = new Map();

/**
 * The company location this customer is buying for, and whether the shared
 * cart is switched on for it. Every Dutch Rusk login belongs to exactly one
 * store today; if a customer ever has several, the browser must say which
 * one (`requestedLocationId`) and it must be one of theirs.
 */
export async function resolveLocation({ shop, customerId, requestedLocationId }) {
  const cacheKey = `${shop}|${customerId}|${requestedLocationId ?? ""}`;
  const hit = locationCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LOCATION_TTL_MS) return hit.value;

  const { admin } = await getAdminToken(shop);
  const res = await admin.graphql(
    `query SharedCartLocation($id: ID!) {
      shop { mode: metafield(namespace: "${NS}", key: "${MODE_KEY}") { value } }
      customer(id: $id) {
        companyContactProfiles {
          roleAssignments(first: 20) {
            nodes {
              companyLocation {
                id
                enabled: metafield(namespace: "${NS}", key: "${ENABLED_KEY}") { value }
              }
            }
          }
        }
      }
    }`,
    { variables: { id: `gid://shopify/Customer/${customerId}` } }
  );
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  const data = json.data;
  const locations = (data.customer?.companyContactProfiles ?? [])
    .flatMap((p) => p.roleAssignments.nodes.map((r) => r.companyLocation))
    .filter(Boolean);
  let location = null;
  if (requestedLocationId) {
    location = locations.find((l) => l.id.endsWith(`/${requestedLocationId}`)) ?? null;
  } else if (locations.length === 1) {
    location = locations[0];
  }
  const enabled = Boolean(location) && (data.shop?.mode?.value === "all" || location.enabled?.value === "true");
  const value = { location, enabled };
  locationCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ── Storage ─────────────────────────────────────────────────────────────────

async function db() {
  return (await import("../db.server.js")).default;
}

export async function readState(shop, locationGid) {
  const prisma = await db();
  const row = await prisma.sharedCart.findUnique({ where: { shop_locationGid: { shop, locationGid } } });
  return toState(row);
}

/**
 * Save the next version, only if the store is still on `baseVersion`.
 * Returns { ok: true, state } or { ok: false, state } with the current state
 * when another device saved first.
 */
export async function writeState(shop, locationGid, { lines, by }, baseVersion) {
  const prisma = await db();
  if (baseVersion === 0) {
    try {
      const row = await prisma.sharedCart.create({ data: { shop, locationGid, version: 1, lines, updatedBy: by ?? null } });
      announce(shop, locationGid, toState(row));
      return { ok: true, state: toState(row) };
    } catch (err) {
      // P2002: the row already exists, so someone else saved first. Fall
      // through to the conditional update, which will report the conflict.
      if (err?.code !== "P2002") throw err;
    }
  }
  const { count } = await prisma.sharedCart.updateMany({
    where: { shop, locationGid, version: baseVersion },
    data: { version: { increment: 1 }, lines, updatedBy: by ?? null },
  });
  const state = await readState(shop, locationGid);
  if (count === 1) announce(shop, locationGid, state);
  return { ok: count === 1, state };
}

/** Tell the store's open devices straight away. Never allowed to fail a save. */
function announce(shop, locationGid, state) {
  import("./shared-cart-events.server.js")
    .then((m) => m.publish(shop, locationGid, { v: state.v, lines: state.lines }))
    .catch((err) => console.error("[shared-cart] publish failed:", err?.message ?? err));
}

/** Called from orders/create: empty the store's shared cart once it has been ordered. */
export async function clearAfterOrder({ shop, locationGid, orderCreatedAt, orderName }) {
  const state = await readState(shop, locationGid);
  if (!shouldClearAfterOrder(state, orderCreatedAt)) return false;
  const res = await writeState(shop, locationGid, { lines: [], by: `order ${orderName}` }, state.v);
  return res.ok;
}
