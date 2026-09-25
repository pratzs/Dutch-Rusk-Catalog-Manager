// Shared cart per store (company location), so a staff member and their
// manager see the same cart on different devices.
//
// Shopify keeps the online store cart in the browser, not the account, so the
// same login on two devices has two carts. This keeps one copy of the cart on
// the company location (metafield custom.shared_cart_state) and the theme
// syncs each browser's cart with it through the app proxy.
//
// Nobody is affected unless the feature is switched on for them:
//   - shop metafield custom.shared_cart_mode: "all" turns it on everywhere,
//     anything else (or unset) means pilot only
//   - company location metafield custom.shared_cart_enabled = true puts that
//     store in the pilot
// The theme checks the same two values before it loads any of this.

import { getAdminToken } from "./admin-token.server.js";

export const NS = "custom";
export const STATE_KEY = "shared_cart_state";
export const ENABLED_KEY = "shared_cart_enabled";
export const MODE_KEY = "shared_cart_mode";

const MAX_LINES = 250;
const MAX_QTY = 9999;
const MAX_PROPS = 20;

// ── Pure helpers (tested in tests/shared-cart.test.js) ──────────────────────

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
 * it, so nothing anyone added is lost.
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

export function emptyState() {
  return { v: 0, lines: [], at: null, by: null };
}

function parseState(value) {
  try {
    const s = JSON.parse(value);
    return { v: Number(s.v) || 0, lines: sanitizeLines(s.lines), at: s.at || null, by: s.by || null };
  } catch {
    return emptyState();
  }
}

// ── Shopify I/O ─────────────────────────────────────────────────────────────

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

/**
 * The company location this customer is buying for, and whether the shared
 * cart is switched on for it. Every Dutch Rusk login belongs to exactly one
 * store today; if a customer ever has several, the browser must say which
 * one (`requestedLocationId`) and it must be one of theirs.
 */
export async function resolveLocation({ shop, customerId, requestedLocationId }) {
  const { admin } = await getAdminToken(shop);
  const data = await gql(
    admin,
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
    { id: `gid://shopify/Customer/${customerId}` }
  );
  const locations = (data.customer?.companyContactProfiles ?? [])
    .flatMap((p) => p.roleAssignments.nodes.map((r) => r.companyLocation))
    .filter(Boolean);
  let location = null;
  if (requestedLocationId) {
    location = locations.find((l) => l.id.endsWith(`/${requestedLocationId}`)) ?? null;
  } else if (locations.length === 1) {
    location = locations[0];
  }
  if (!location) return { admin, location: null, enabled: false };
  const enabled = data.shop?.mode?.value === "all" || location.enabled?.value === "true";
  return { admin, location, enabled };
}

export async function readState(admin, locationGid) {
  const data = await gql(
    admin,
    `query SharedCartState($id: ID!) {
      companyLocation(id: $id) {
        state: metafield(namespace: "${NS}", key: "${STATE_KEY}") { value compareDigest }
      }
    }`,
    { id: locationGid }
  );
  const mf = data.companyLocation?.state;
  return { state: mf?.value ? parseState(mf.value) : emptyState(), digest: mf?.compareDigest ?? null };
}

/**
 * Write the next version, guarded by compareDigest so two devices saving at
 * the same moment cannot silently overwrite each other. Returns
 * { ok: true, state } or { ok: false, conflict: true } when someone else won.
 */
export async function writeState(admin, locationGid, { lines, by }, digest, currentVersion) {
  const next = { v: currentVersion + 1, lines, at: new Date().toISOString(), by: by ?? null };
  const input = { ownerId: locationGid, namespace: NS, key: STATE_KEY, type: "json", value: JSON.stringify(next) };
  if (digest) input.compareDigest = digest;
  const data = await gql(
    admin,
    `mutation SharedCartWrite($mf: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $mf) { userErrors { field message code } }
    }`,
    { mf: [input] }
  );
  const errs = data.metafieldsSet?.userErrors ?? [];
  if (errs.some((e) => e.code === "STALE_OBJECT" || /digest|stale/i.test(e.message))) return { ok: false, conflict: true };
  if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
  return { ok: true, state: next };
}

/** Called from orders/create: empty the store's shared cart once it has been ordered. */
export async function clearAfterOrder({ admin, locationGid, orderCreatedAt, orderName }) {
  const { state, digest } = await readState(admin, locationGid);
  if (!shouldClearAfterOrder(state, orderCreatedAt)) return false;
  const res = await writeState(admin, locationGid, { lines: [], by: `order ${orderName}` }, digest, state.v);
  return res.ok;
}
