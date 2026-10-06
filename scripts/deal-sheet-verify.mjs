// Read a month's deal rows back from Shopify and prove they are what was planned.
//
//   node scripts/deal-sheet-verify.mjs rows.json
//
// For each row in the file written by deal-sheet-plan.mjs:
//   price    the General fixed price equals dealPrice
//   break    the quantity break exists at minQty for dealPrice
//   listing  the product carries the deal-sheet tag
// Exits non-zero if anything is off, so it can gate the "done" message.
import fs from "node:fs";
import prisma from "../app/db.server.js";
import { adminGql } from "../app/lib/brand-order.server.js";
import { liveRows, DEAL_TAG } from "../app/lib/deal-sheet.server.js";

const GENERAL = "gid://shopify/PriceList/34326708537";
const file = process.argv[2];
if (!file) { console.error("usage: node scripts/deal-sheet-verify.mjs rows.json"); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(file, "utf8"));
const session = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
const gql = adminGql(session.shop, session.accessToken);

const bad = [];
const priceRows = rows.filter((r) => r.kind === "price");
const live = await liveRows(gql, GENERAL, priceRows.map((r) => r.variantGid));
for (const r of priceRows) {
  const l = live[r.variantGid];
  if (!l || Math.abs(l.price - r.dealPrice) > 0.005) bad.push(`price ${r.variantGid}: expected ${r.dealPrice}, found ${l ? l.price : "no fixed price"}`);
  else if (l.compareAt == null || Math.abs(l.compareAt - l.retail) > 0.005) bad.push(`compare-at ${r.variantGid}: ${l.compareAt} is not retail ${l.retail}`);
}

const breakRows = rows.filter((r) => r.kind === "break");
for (let i = 0; i < breakRows.length; i += 20) {
  const chunk = breakRows.slice(i, i + 20);
  const q = chunk.map((r) => `variant_id:${r.variantGid.slice(r.variantGid.lastIndexOf("/") + 1)}`).join(" OR ");
  const d = await gql(
    `query($id:ID!,$q:String){ priceList(id:$id){ prices(first:250, query:$q){ nodes{ variant{ id } quantityPriceBreaks(first:10){ nodes{ minimumQuantity price{ amount } } } } } } }`,
    { id: GENERAL, q },
  );
  const byVariant = Object.fromEntries(d.priceList.prices.nodes.map((n) => [n.variant.id, n.quantityPriceBreaks.nodes]));
  for (const r of chunk) {
    const hit = (byVariant[r.variantGid] ?? []).find((b) => b.minimumQuantity === r.minQty && Math.abs(parseFloat(b.price.amount) - r.dealPrice) < 0.005);
    if (!hit) bad.push(`break ${r.variantGid}: no ${r.minQty}+ at ${r.dealPrice}`);
  }
}

const listingRows = rows.filter((r) => r.kind === "listing");
const variantIds = [...new Set(listingRows.map((r) => r.variantGid))];
const products = new Map();
for (let i = 0; i < variantIds.length; i += 100) {
  const d = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant{ id product{ id tags } } } }`, { ids: variantIds.slice(i, i + 100) });
  for (const n of d.nodes) if (n) products.set(n.product.id, n.product.tags.includes(DEAL_TAG));
}
for (const [id, tagged] of products) if (!tagged) bad.push(`tag ${id}: missing ${DEAL_TAG}`);

console.log(`Checked ${priceRows.length} price, ${breakRows.length} break, ${products.size} product tag(s).`);
if (bad.length) { console.log(`PROBLEMS (${bad.length}):\n  ` + bad.slice(0, 30).join("\n  ")); process.exitCode = 1; }
else console.log("All match Shopify.");
await prisma.$disconnect();
