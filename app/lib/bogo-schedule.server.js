// Which BOGO deals are switched on THIS month.
//
// RULE (from the business, 6 Oct 2026): a BOGO deal runs only in the months a
// deal sheet lists it. Exceptions that run all year: the Dragon deals and
// Bundaberg. Nothing else should linger after its month.
//
// HOW
//   custom.bogo_master    EVERY bundle, with its schedule. The admin page edits
//                         this one. Not read by the storefront or the Function.
//   custom.bogo_bundles   ONLY the bundles active this month. Everything that
//                         already read this key keeps working unchanged: the
//                         theme badge, the Special Deals page, the deal access
//                         list, the catalog price sync's deal markers.
//   discountNode bogo_fn + bogo_bundles
//                         the same active set, in the shapes the checkout
//                         Function reads. A deal missing here is not applied at
//                         checkout.
//
// A bundle's schedule is `months`, a list of "YYYY-MM" (NZ time):
//   absent / null  -> all year
//   ["2026-10"]    -> only October 2026
//   []             -> off until a month is added
//
// reconcileBogo() makes the active set match the calendar. It runs from the
// hourly Catalog Pricing job, so a deal ends when the month turns, not when
// someone remembers. It writes nothing when nothing has changed.
const NS = "custom";
export const MASTER_KEY = "bogo_master";
export const ACTIVE_KEY = "bogo_bundles";
export const FUNCTION_KEY = "bogo_fn";

/** "YYYY-MM" in New Zealand time. */
export function nzMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

export function isActiveIn(bundle, ym) {
  if (!Array.isArray(bundle?.months)) return true; // no schedule = all year
  return bundle.months.includes(ym);
}

export function describeSchedule(bundle) {
  if (!Array.isArray(bundle?.months)) return "All year";
  return bundle.months.length ? bundle.months.join(", ") : "Off (no months set)";
}

/** Parse the "months" text field: "2026-10, 2026-11" -> array; blank -> null (all year). */
export function parseMonths(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const months = raw.split(/[\s,;]+/).filter(Boolean);
  for (const m of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error(`"${m}" is not a month. Use YYYY-MM, for example 2026-11.`);
  }
  return [...new Set(months)].sort();
}

// ---- shapes the checkout Function reads (moved here from the admin page) ----

/** "gid://shopify/ProductVariant/123" -> "123" */
function bareId(gid) {
  return typeof gid === "string" ? gid.slice(gid.lastIndexOf("/") + 1) : gid;
}

// The shape the CURRENTLY LIVE Function reads, kept so that deploying the app
// ahead of the Functions does not switch deals off in between.
const LEGACY_FUNCTION_FIELDS = ["buyQty", "getQty", "variantIds", "catalogIds", "overridePct"];

export function forLegacyFunction(bundle) {
  const out = {};
  for (const field of LEGACY_FUNCTION_FIELDS) {
    if (bundle?.[field] !== undefined) out[field] = bundle[field];
  }
  return out;
}

/**
 * The copy the Function reads, squeezed as small as it will go. This config is
 * part of the Function's INPUT, sent on every cart, and input bytes cost
 * instructions against an 11M budget that big carts genuinely run out of.
 *   i = deal id, b = buyQty, g = getQty, o = overridePct, c = catalog ids,
 *   v = variant ids (kept only so a rollout cannot break the previous Function)
 * The SHOP copy keeps the full, readable form for the theme badge.
 */
export function forFunction(bundle) {
  const out = {};
  if (bundle?.id !== undefined) out.i = bundle.id;
  if (bundle?.buyQty !== undefined) out.b = bundle.buyQty;
  if (bundle?.getQty !== undefined) out.g = bundle.getQty;
  if (bundle?.overridePct !== undefined && bundle.overridePct !== null && bundle.overridePct !== "") out.o = bundle.overridePct;
  if (Array.isArray(bundle?.catalogIds) && bundle.catalogIds.length) out.c = bundle.catalogIds.map(bareId);
  if (Array.isArray(bundle?.variantIds)) out.v = bundle.variantIds.map(bareId);
  return out;
}

export async function findPricingDiscountId(gql) {
  const data = await gql(`query { discountNodes(first: 50) { nodes { id discount { __typename ... on DiscountAutomaticApp { title } } } } }`);
  const node = data?.discountNodes?.nodes?.find((n) => n.discount?.__typename === "DiscountAutomaticApp" && n.discount.title === "B2B Wholesale Custom Pricing");
  return node?.id ?? null;
}

function parseList(value) {
  try {
    const v = JSON.parse(value || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Master list, the active list as stored, and whether a master exists yet. */
export async function readState(gql) {
  const data = await gql(
    `query { shop { id master: metafield(namespace: "${NS}", key: "${MASTER_KEY}") { value } active: metafield(namespace: "${NS}", key: "${ACTIVE_KEY}") { value } } }`,
  );
  const masterExists = data?.shop?.master?.value != null;
  const active = parseList(data?.shop?.active?.value);
  // First run: the live list IS the master. Nothing is lost on the way in.
  const master = masterExists ? parseList(data.shop.master.value) : active;
  return { shopId: data?.shop?.id, master, active, masterExists };
}

/** Write the master and the month's active subset to every place that reads them. */
export async function writeBundles(gql, shopId, master, { now = new Date() } = {}) {
  const ym = nzMonth(now);
  const active = master.filter((b) => isActiveIn(b, ym));
  const metafields = [
    { ownerId: shopId, namespace: NS, key: MASTER_KEY, type: "json", value: JSON.stringify(master) },
    { ownerId: shopId, namespace: NS, key: ACTIVE_KEY, type: "json", value: JSON.stringify(active) },
  ];
  // The Function merged into "B2B Wholesale Custom Pricing" reads its config
  // from discountNode.metafield, not shop.metafield (confirmed by testing).
  const pricingDiscountId = await findPricingDiscountId(gql);
  if (pricingDiscountId) {
    metafields.push({ ownerId: pricingDiscountId, namespace: NS, key: ACTIVE_KEY, type: "json", value: JSON.stringify(active.map(forLegacyFunction)) });
    // Its own key, so deploying the app before the Functions cannot make the
    // live Function read a shape it does not understand and drop every deal.
    metafields.push({ ownerId: pricingDiscountId, namespace: NS, key: FUNCTION_KEY, type: "json", value: JSON.stringify(active.map(forFunction)) });
  }
  const res = await gql(
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    { m: metafields },
  );
  const errs = res?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
  if (!pricingDiscountId) {
    throw new Error("Saved to the theme badge metafield, but couldn't find the live pricing discount to update -- checkout won't reflect this change until that's fixed.");
  }
  return { month: ym, active: active.map((b) => b.id), inactive: master.filter((b) => !isActiveIn(b, ym)).map((b) => b.id) };
}

/**
 * Make the live active set match the calendar. Returns { changed, month, active, inactive }.
 * Writes nothing when the shop copy and the Function copy already match.
 */
export async function reconcileBogo(gql, { now = new Date(), log = console.log } = {}) {
  const state = await readState(gql);
  const ym = nzMonth(now);
  const desired = state.master.filter((b) => isActiveIn(b, ym));

  let fnCurrent = null;
  const discountId = await findPricingDiscountId(gql);
  if (discountId) {
    const d = await gql(`query($id:ID!){ discountNode(id:$id){ metafield(namespace:"${NS}", key:"${FUNCTION_KEY}"){ value } } }`, { id: discountId });
    fnCurrent = d?.discountNode?.metafield?.value ?? null;
  }
  const same =
    state.masterExists &&
    JSON.stringify(state.active) === JSON.stringify(desired) &&
    fnCurrent === JSON.stringify(desired.map(forFunction));
  if (same) return { changed: false, month: ym, active: desired.map((b) => b.id), inactive: state.master.filter((b) => !isActiveIn(b, ym)).map((b) => b.id) };

  const r = await writeBundles(gql, state.shopId, state.master, { now });
  log(`[bogo-schedule] ${ym}: active ${r.active.join(", ") || "none"} | off ${r.inactive.join(", ") || "none"}`);
  return { changed: true, ...r };
}
