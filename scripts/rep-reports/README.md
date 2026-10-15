# Rep reports (FY location and channel)

One Excel workbook per Ostendo rep code, same layout as the Chris (460) report. Requested by Kishan, 15 Oct 2026. Standing report: re-run to refresh.

Workbook pages: Summary (online vs rep side by side), By Region (online vs rep per region plus chart, stores under each region), Online Orders (with proof), All Invoices, Method and Limits. Plain words, no guesses: every figure is a recorded fact or labelled as probable.

Output home (OneDrive): `Worthy Ecommerce - Documents/03.Dutch Rusk E-Commerce Project/Ostendo Reports/Rep Reports/<period folder>`.
ClickUp card: https://app.clickup.com/t/14yhc7kwtc7

## Refresh
1. `set -a; . C:/Users/PrathamJani/worthy-dashboard/.env.local; set +a; sh scripts/rep-reports/pull_ostendo.sh DATA_DIR` (writes hdr.json)
2. `node scripts/rep-reports/pull-shopify-orders.mjs DATA_DIR/shop.json` (uses the app session token, needs read_orders)
2b. Old-site orders into `DATA_DIR/oldsite.txt`: see pull_old_site.md.
3. `python -I scripts/rep-reports/build_rep_reports.py DATA_DIR OUT_DIR 2026-04-01 2026-10-14`

Use a new period folder name each time. Keep DATA_DIR outside the repo.

## Rules and traps
- Rep names are hardcoded in `REPS` (Ostendo has no salesperson table). `-1` suffixes fold into the base code.
- Figures are invoice net, ex GST; credits shown separately; reversed invoices excluded. Totals match raw Ostendo per rep code to the cent (audit.py).
- Values are numbers, not formulas (no LibreOffice here; phone previewers show uncached formulas blank).
- **Online workflow (Pratham, 15 Oct):** online orders (Shopify, old site, emailed old-site orders) are forwarded by admin to the rep, who re-keys them with their own discounts and deletes the source order; the office sometimes keys under 450 and assigns the rep later. So amounts rarely survive.
- Evidence only. Old-site login -> Ostendo store is linked by (a) the login's business name (dr-admin Users page, `oldusers.txt`) equal to the store name, or (b) 2+ exact-amount matches at that store. Shopify company -> store: every word of the store name (2+ words) appears in the portal company/location name. One lucky amount match is NOT a link (an earlier build let a login map to 18 stores).
- Confirmed online = linked store, same amount within 0.2%, invoiced -1 to +14 days after the online order. Probably online = linked store, invoice 0 to +10 days later at 0.5x-1.6x the amount, or same store/day/amount twice. One online order per invoice.
- Regions (no delivery address in Ostendo): directly billed store = its own billing city; or Shopify portal delivery address on a strict full-name match; else "Not placed". Chain head office addresses are never used (Night n Day stores everywhere bill from Dunedin). No town-in-name guessing.
- Results must not depend on hash order: iterate sorted.
- The build asserts channels, regions and counts add up. `audit.py DATA OUT` independently re-checks totals, every online proof line, no order/invoice used twice, and 25 random invoices live against Ostendo. Run it before sending anything.
- The proper fix for exact online numbers: the Ostendo Sales Order list has a Created By field (XQS = online) but only on the manual Order Screen export, not the API. Export FY26 and use it instead of inference.
- `SYSUSERCREATED` is the invoicing user. `GROUPORDERNUMBERS` starting `S` is ~25% of invoices every month since 2025, so it is not an online flag.
- Corporate EDI = billed to Foodstuffs South Island Ltd only (`EDI_CUSTOMERS`).
