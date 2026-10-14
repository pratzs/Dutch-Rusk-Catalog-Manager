// Pulls every Shopify B2B order (company, location, date, ex-GST subtotal) to a JSON file.
// Usage: node scripts/rep-reports/pull-shopify-orders.mjs OUT.json
import fs from "node:fs";
import prisma from "../../app/db.server.js";
import { adminGql } from "../../app/lib/brand-order.server.js";

const out = process.argv[2];
const session = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
const gql = adminGql(session.shop, session.accessToken);
const Q = `query($after:String){ orders(first:100, after:$after, sortKey:CREATED_AT){ pageInfo{hasNextPage endCursor} nodes{
  name createdAt cancelledAt displayFinancialStatus sourceName
  currentSubtotalPriceSet{shopMoney{amount}}
  purchasingEntity{ ... on PurchasingCompany{ company{name} location{name} } } } } }`;
let after = null, all = [];
for (;;) {
  const d = await gql(Q, { after });
  const o = d.orders; all.push(...o.nodes);
  if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
}
fs.writeFileSync(out, JSON.stringify(all));
console.log("orders", all.length);
await prisma.$disconnect();
