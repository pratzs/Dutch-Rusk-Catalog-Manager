// Apply a month's deal sheet to the General Catalog and register it.
//
//   node scripts/deal-sheet-apply.mjs rows.json --month 2026-11            (dry run)
//   node scripts/deal-sheet-apply.mjs rows.json --month 2026-11 --apply
//
// rows.json is a list of already-matched variants, one per variant:
//   [{ "kind":"price", "variantGid":"gid://shopify/ProductVariant/1", "dealPrice":40.44, "label":"Calypso" },
//    { "kind":"break", "variantGid":"...", "dealPrice":40.44, "minQty":4, "label":"Calypso Buy 4+" }]
// dealPrice is the price for THAT variant's pack size: the sheet's per-single
// price x the singles in the pack. Matching sheet lines to variants is a human
// (or Claude) job, because a line names a group ("all Medium Bars Mars &
// Cadbury") rather than a product. Run it as a dry run first and read the plan.
//
// Reads the stored admin token directly, so it runs from a dev machine whose
// .env points at the production database. Deals end at 00:00 NZ on the 1st of
// the month after --month; the hourly Catalog Pricing job puts them back.
import fs from "node:fs";
import prisma from "../app/db.server.js";
import { adminGql } from "../app/lib/brand-order.server.js";
import { applyDealRows } from "../app/lib/deal-sheet.server.js";

const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const month = process.argv[process.argv.indexOf("--month") + 1];
const apply = process.argv.includes("--apply");
if (!file || !/^\d{4}-\d{2}$/.test(month ?? "")) {
  console.error("usage: node scripts/deal-sheet-apply.mjs rows.json --month YYYY-MM [--apply]");
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(file, "utf8"));
const session = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
const gql = adminGql(session.shop, session.accessToken);
const GENERAL = "gid://shopify/PriceList/34326708537";

const result = await applyDealRows(gql, { shop: session.shop, priceListId: GENERAL, month, rows, dryRun: !apply });
const kinds = {};
for (const p of result.plan) kinds[p.baseKind] = (kinds[p.baseKind] || 0) + 1;
console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${result.plan.length} price row(s) (will return to: ${JSON.stringify(kinds)}), ${result.breakRows.length} break(s), ends ${result.endsAt.toISOString()}`);
if (!apply) console.log("Nothing written. Re-run with --apply.");
await prisma.$disconnect();
