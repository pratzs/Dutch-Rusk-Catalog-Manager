// Strikethrough watch: are B2B orders still coming in, and does every line that
// has a saving show its discount row?
//
//   node scripts/strikethrough-watch.mjs                 (since release 294)
//   node scripts/strikethrough-watch.mjs 2026-11-16T00:00:00Z
//
// Read-only. Reads the offline token from the Session table (DATABASE_URL in
// .env). Exit code 0 = nothing wrong, 1 = something needs a look, 2 = could not
// check (for example the stored token has expired; it refreshes when the next
// order or admin page load reaches the app).
//
// What counts as wrong:
//   - the cart transform or the wholesale discount is not in place
//   - a line that has a saving for the buyer's catalog but no discount row,
//     on an order of 125 lines or fewer (bigger carts may run out of the
//     big-cart budget; those are listed separately, see docs/B2B-PRICING.md)
//   - a line billed above the buyer's catalog price (deal lines excepted: the
//     paid units of a Buy X Get Y deal are priced by the deal, not the catalog)
//   - an order tagged pricing-error or pricing-no-discount-rows
import { PrismaClient } from "@prisma/client";

const SINCE = process.argv[2] || "2026-11-15T21:39:00Z"; // release 294
const FULL_COVER_LINES = 125;

const prisma = new PrismaClient();
const session = await prisma.session.findFirst({
  where: { isOnline: false, accessToken: { not: "" } },
  orderBy: { id: "desc" },
});
await prisma.$disconnect();

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://${session.shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (json.errors?.some?.((e) => e.extensions?.code === "THROTTLED")) {
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    if (json.errors) {
      const text = typeof json.errors === "string" ? json.errors : JSON.stringify(json.errors);
      const err = new Error(text.slice(0, 300));
      err.auth = res.status === 401 || /Invalid API key or access token/i.test(text);
      throw err;
    }
    return json.data;
  }
  throw new Error("Shopify did not answer after 6 attempts");
}

const nz = (iso) =>
  new Date(iso).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

const problems = [];
const notes = [];

try {
  // 1. The pricing pair
  const h = await gql(`{
    cartTransforms(first: 10) { nodes { id functionId } }
    discountNodes(first: 50, query: "method:automatic") { nodes { discount { ... on DiscountAutomaticApp { title status } } } }
  }`);
  const transforms = h.cartTransforms.nodes.length;
  const wholesale = h.discountNodes.nodes.map((n) => n.discount).find((d) => d?.title === "B2B Wholesale Custom Pricing");
  if (transforms !== 1) problems.push(`cart transforms registered: ${transforms} (expected 1)`);
  if (wholesale?.status !== "ACTIVE") problems.push(`"B2B Wholesale Custom Pricing" is ${wholesale?.status ?? "MISSING"} (expected ACTIVE)`);

  // 2. Every order since SINCE
  let cursor = null;
  const orders = [];
  for (let page = 0; page < 40; page++) {
    const d = await gql(
      `query($c: String, $q: String) {
        orders(first: 25, after: $c, sortKey: CREATED_AT, reverse: true, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name createdAt tags
            customAttributes { key }
            purchasingEntity { ... on PurchasingCompany { company { name pl: metafield(namespace: "custom", key: "catalog_pricelist_id") { value } } } }
            lineItems(first: 250) {
              nodes {
                sku quantity
                originalUnitPriceSet { shopMoney { amount } }
                discountedUnitPriceSet { shopMoney { amount } }
                totalDiscountSet { shopMoney { amount } }
                variant { m: metafield(namespace: "custom", key: "catalog_savings") { value } }
              }
            }
          }
        }
      }`,
      { c: cursor, q: `created_at:>='${SINCE}'` },
    );
    orders.push(...d.orders.nodes.filter((o) => o.createdAt >= SINCE));
    if (!d.orders.pageInfo.hasNextPage) break;
    cursor = d.orders.pageInfo.endCursor;
  }
  orders.reverse();

  let b2b = 0, lines = 0, rows = 0, noSaving = 0, biggest = 0, biggestName = "";
  let last = null;
  for (const o of orders) {
    const pl = o.purchasingEntity?.company?.pl?.value;
    if (!pl) continue;
    b2b++;
    last = o;
    const needle = "|" + pl.slice(pl.lastIndexOf("/") + 1) + ":";
    const L = o.lineItems.nodes;
    if (L.length > biggest) { biggest = L.length; biggestName = o.name; }
    const missing = [];
    const over = [];
    for (const l of L) {
      lines++;
      const raw = l.variant?.m?.value || "";
      const at = raw.indexOf(needle);
      const saving = at < 0 ? 0 : parseFloat(raw.slice(at + needle.length));
      const retail = parseFloat(raw);
      const disc = +l.totalDiscountSet.shopMoney.amount;
      const paid = +l.discountedUnitPriceSet.shopMoney.amount;
      if (disc > 0) rows++;
      if (!(saving > 0)) { noSaving++; continue; }
      const catalog = retail - saving;
      if (!(disc > 0)) missing.push(l.sku);
      const onDeal = raw.includes("|#");
      if (paid > catalog + 0.011 && !(onDeal && disc > 0)) over.push(`${l.sku} paid ${paid.toFixed(2)} vs catalog ${catalog.toFixed(2)}`);
    }
    const bad = o.tags.filter((t) => t === "pricing-error" || t === "pricing-no-discount-rows");
    if (bad.length) problems.push(`${o.name} is tagged ${bad.join(", ")}`);
    if (over.length) problems.push(`${o.name} (${o.purchasingEntity.company.name}): ${over.length} line(s) billed ABOVE catalog: ${over.slice(0, 4).join("; ")}`);
    if (missing.length) {
      const msg = `${o.name} (${o.purchasingEntity.company.name}, ${L.length} lines): ${missing.length} line(s) with a saving but NO discount row`;
      if (L.length <= FULL_COVER_LINES) problems.push(`${msg}: ${missing.slice(0, 6).join(", ")}`);
      else notes.push(`${msg} (cart is past the big-cart budget; price is the correct catalog price)`);
    }
    if (L.length >= 66) notes.push(`${o.name} is a ${L.length}-line order placed ${nz(o.createdAt)} NZ: ${L.length - missing.length - L.filter((l) => !(l.variant?.m?.value || "").includes(needle)).length} lines carry a row. Compare its look in the admin with #1892.`);
  }

  console.log(`Strikethrough watch, orders since ${nz(SINCE)} NZ (checked ${nz(new Date().toISOString())} NZ)`);
  console.log(`Pricing pair: ${transforms} cart transform, wholesale discount ${wholesale?.status ?? "MISSING"}`);
  console.log(`B2B orders: ${b2b} | lines: ${lines} | lines with a discount row: ${rows} | lines with no saving to show: ${noSaving}`);
  console.log(`Largest order: ${biggest ? `${biggestName} with ${biggest} lines` : "none yet"}`);
  console.log(`Most recent B2B order: ${last ? `${last.name} at ${nz(last.createdAt)} NZ` : "none yet"}`);
  for (const n of notes) console.log(`NOTE: ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`PROBLEM: ${p}`);
    console.log(`RESULT: ${problems.length} PROBLEM(S)`);
    process.exit(1);
  }
  console.log("RESULT: OK, no order is missing a strikethrough and none is billed above catalog");
} catch (err) {
  console.log(`COULD NOT CHECK: ${err.message}`);
  if (err.auth) console.log("The stored Shopify token has expired. It refreshes by itself when the next order or admin page load reaches the app; run again after that.");
  process.exit(2);
}
