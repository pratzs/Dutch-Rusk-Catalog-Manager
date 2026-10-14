# Rep reports (FY location and channel)

One Excel workbook per Ostendo rep code, same layout as the Chris (460) report. Requested by Kishan, 15 Oct 2026. Standing report: re-run to refresh.

Output home (OneDrive): `Worthy Ecommerce - Documents/03.Dutch Rusk E-Commerce Project/Ostendo Reports/Rep Reports/<period folder>`.
ClickUp card: https://app.clickup.com/t/14yhc7kwtc7

## Refresh
1. `set -a; . C:/Users/PrathamJani/worthy-dashboard/.env.local; set +a; sh scripts/rep-reports/pull_ostendo.sh DATA_DIR` (writes hdr.json)
2. `node scripts/rep-reports/pull-shopify-orders.mjs DATA_DIR/shop.json` (uses the app session token, needs read_orders)
3. `python -I scripts/rep-reports/build_rep_reports.py DATA_DIR OUT_DIR 2026-04-01 2026-10-14`

Use a new period folder name each time. Keep DATA_DIR outside the repo.

## Rules and traps
- Rep code names are hardcoded in `REPS`: Ostendo has no salesperson table. `-1` suffixes fold into the base code.
- Figures are invoice net (ex GST). Credits shown separately. Reversed invoices excluded (rep 490 differed by one credit, $871.78, from the earlier summary).
- Values are written as numbers, not formulas: no LibreOffice here, and phone previewers show uncached formulas as blank.
- Online = Shopify order matched 1-to-1 to an invoice (store tokens, amount within 12%, -1 to +14 days) OR the duplicate-redo rule (same store, day and amount twice: rep re-keyed an online order). It is a floor: old dr-admin orders are invisible and its deletion log is 403.
- `SYSUSERCREATED` is the invoicing user, not the order source. Order "Created By" (XQS = online) exists only on the manual Order Screen export.
- `GROUPORDERNUMBERS` starting with `S` is about 25% of invoices every month since 2025, before Shopify existed, so it is NOT an online flag.
- Corporate EDI = billed to Foodstuffs South Island Ltd only (`EDI_CUSTOMERS`). Region = billing city; Ostendo has no delivery address.
- Chris online share is 2.7% here versus 9% in the earlier hand-built report (looser name matching). Method to be agreed with Kishan.
