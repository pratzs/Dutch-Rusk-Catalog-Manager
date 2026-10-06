// Turn one month's deal sheet lines into a reviewable plan and an apply file.
//
//   node scripts/deal-sheet-plan.mjs lines.json            -> plan, nothing written to Shopify
//
// Writes next to lines.json:
//   <name>.plan.csv    every variant: units, retail, General today, new price, % off retail,
//                      status, flags. This is what gets read and signed off.
//   <name>.rows.json   the rows for scripts/deal-sheet-apply.mjs --month YYYY-MM
//
// lines.json (one entry per line on the sheet; Claude reads these off the PDF):
//   { "month": "2026-11",
//     "lines": [
//       { "line": "Kool Aid 12ct", "match": "^Kool Aid", "price": 2.90, "badge": null, "baseUnits": 12 },
//       { "line": "Calypso", "match": "^Calyp(so|os) (Triple Melon|Ocean Blue)", "price": null,
//         "break": { "minQty": 4, "price": 3.37 }, "baseUnits": 12 } ] }
//
//   match      regex on the product title (case-insensitive), ACTIVE products only
//   exclude    optional regex to leave products out
//   price      the sheet's price PER SINGLE, ex GST. null = leave the base General price alone
//   badge      the % off printed on the sheet, or null (used only to flag a mismatch)
//   baseUnits  singles in a plain "Outer" or "Shipper" variant with no "(N x)" in its name;
//              usually the "x 12ct" in the product title. Default 1.
//   baseUnitsFromTitle  true = read that count from each product's own "x NNct" instead
//              (use it when one line covers products with different counts, like the
//              medium bars: 20, 25, 35, 40, 42, 48, 50)
//   break      optional quantity break: { minQty, price } where price is per single
//
// RULES THIS ENCODES (see docs/MONTHLY-DEAL-SHEET-RUNBOOK.md):
//   - the printed price wins, even if the badge % disagrees (it is flagged, not changed)
//   - sheet prices are per single; a variant's price is single x singles in that pack size
//   - a line covers the whole group it names, so `match` should be the group, not one product
//   - same product, same price
// Every row that looks odd is FLAGGED so a person decides; nothing is applied here.
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/db.server.js";
import { adminGql } from "../app/lib/brand-order.server.js";
import { liveRows, unitsOf } from "../app/lib/deal-sheet.server.js";

const GENERAL = "gid://shopify/PriceList/34326708537";
const r2 = (x) => Math.round(x * 100) / 100;
const file = process.argv[2];
if (!file) { console.error("usage: node scripts/deal-sheet-plan.mjs lines.json"); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(file, "utf8"));
const out = (ext) => path.join(path.dirname(file), path.basename(file).replace(/\.json$/, "") + ext);

const session = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
const gql = adminGql(session.shop, session.accessToken);

// every product with its variants, once
const products = [];
let after = null;
do {
  const d = await gql(`query($a:String){ products(first:50, after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title status variants(first:20){ nodes{ id title sku price } } } } }`, { a: after });
  products.push(...d.products.nodes);
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

const matched = [];
const noMatch = [];
for (const L of spec.lines) {
  const re = new RegExp(L.match, "i");
  const ex = L.exclude ? new RegExp(L.exclude, "i") : null;
  const ps = products.filter((p) => p.status === "ACTIVE" && re.test(p.title) && !(ex && ex.test(p.title)));
  if (!ps.length) noMatch.push(L.line);
  for (const p of ps) for (const v of p.variants.nodes) matched.push({ L, p, v });
}

// today's General fixed price for every matched variant
const live = await liveRows(gql, GENERAL, [...new Set(matched.map((m) => m.v.id))]);

const rows = [];   // for the CSV
const apply = [];  // for deal-sheet-apply.mjs
for (const { L, p, v } of matched) {
  const fromTitle = L.baseUnitsFromTitle ? Number((p.title.match(/(?:x|-)\s?(\d+)\s?ct/i) || [])[1]) : null;
  if (L.baseUnitsFromTitle && !fromTitle) throw new Error(`"${p.title}" has no "x NNct" (or "- NNct") in its title, so its pack count cannot be read`);
  const units = unitsOf(v.title, fromTitle ?? L.baseUnits ?? 1);
  const retail = parseFloat(v.price);
  const today = live[v.id] ? live[v.id].price : retail;
  const flags = [];
  let status = "Listing only (base price unchanged)";
  let newPrice = today;

  if (L.price != null) {
    newPrice = r2(L.price * units);
    const d = newPrice - today;
    status = Math.abs(d) <= 0.011 ? "No change" : d > 0 ? "Price goes UP" : "Price goes down";
    const off = Math.round((1 - newPrice / retail) * 1000) / 10;
    if (newPrice > retail + 0.005) flags.push("above retail");
    if (off > 40) flags.push(`${off}% off retail`);
    if (L.badge != null && Math.abs(off - L.badge) > 1.5) flags.push(`badge ${L.badge}% but price is ${off}% off retail`);
    if (status !== "No change") apply.push({ kind: "price", variantGid: v.id, dealPrice: newPrice, label: L.line });
  }
  let breakPrice = null;
  if (L.break) {
    breakPrice = r2(L.break.price * units);
    apply.push({ kind: "break", variantGid: v.id, dealPrice: breakPrice, minQty: L.break.minQty, label: `${L.line} Buy ${L.break.minQty}+` });
  }
  // every product on the sheet is listed, so it gets the Deals tag and badge
  apply.push({ kind: "listing", variantGid: v.id, dealPrice: 0, label: L.line });
  if (live[v.id] === undefined && L.price != null) flags.push("no fixed price today (General pays retail)");

  rows.push({ line: L.line, product: p.title, sku: v.sku, pack: v.title, units, retail, today, newPrice, breakPrice, off: L.price != null ? Math.round((1 - newPrice / retail) * 1000) / 10 : "", status, flags: flags.join("; "), variantId: v.id.split("/").pop() });
}

// same product, same price: within one sheet line every variant must work out to the same
// price PER SINGLE (pack sizes and counts differ, the single price does not)
const byLine = {};
for (const r of rows) if (r.off !== "") (byLine[r.line] ??= new Set()).add((r.newPrice / r.units).toFixed(2));
const inconsistent = Object.entries(byLine).filter(([, s]) => s.size > 1).map(([k, s]) => `${k} (${[...s].join(" / ")} per single)`);

const header = ["Sheet line", "Product", "SKU", "Pack", "Singles", "Retail", "General today", "New price (ex GST)", "Break price", "% off retail", "Status", "Flags", "Variant ID"];
const csv = [header, ...rows.map((r) => [r.line, r.product, r.sku, r.pack, r.units, r.retail, r.today, r.newPrice, r.breakPrice ?? "", r.off, r.status, r.flags, r.variantId])]
  .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
fs.writeFileSync(out(".plan.csv"), csv);
fs.writeFileSync(out(".rows.json"), JSON.stringify(apply, null, 1));

const count = (f) => rows.filter(f).length;
console.log(`Month ${spec.month}: ${spec.lines.length} sheet lines -> ${new Set(matched.map((m) => m.p.id)).size} products, ${rows.length} variants`);
console.log(`  no change ${count((r) => r.status === "No change")} | goes down ${count((r) => r.status === "Price goes down")} | goes UP ${count((r) => r.status === "Price goes UP")} | listing only ${count((r) => r.status.startsWith("Listing"))}`);
console.log(`  quantity breaks: ${rows.filter((r) => r.breakPrice != null).length} variants | flagged rows: ${count((r) => r.flags)}`);
if (noMatch.length) console.log(`  NO PRODUCT FOUND for: ${noMatch.join(" | ")}`);
if (inconsistent.length) console.log(`  SAME PRODUCT, DIFFERENT PRICE (fix before applying): ${inconsistent.join(" | ")}`);
console.log(`Wrote ${out(".plan.csv")} and ${out(".rows.json")}. Nothing was written to Shopify.`);
await prisma.$disconnect();
