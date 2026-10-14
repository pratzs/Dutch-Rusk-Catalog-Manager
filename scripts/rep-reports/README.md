# Rep reports (FY location and channel)

One Excel workbook per Ostendo rep code, same layout as the Chris (460) report. Requested by Kishan, 15 Oct 2026. Standing report: re-run to refresh.

Output home (OneDrive): `Worthy Ecommerce - Documents/03.Dutch Rusk E-Commerce Project/Ostendo Reports/Rep Reports/<period folder>`.
ClickUp card: https://app.clickup.com/t/14yhc7kwtc7

## Refresh
1. `set -a; . C:/Users/PrathamJani/worthy-dashboard/.env.local; set +a; sh scripts/rep-reports/pull_ostendo.sh DATA_DIR` (writes hdr.json)
2. `node scripts/rep-reports/pull-shopify-orders.mjs DATA_DIR/shop.json` (uses the app session token, needs read_orders)
2b. Old-site orders into `DATA_DIR/oldsite.txt`: see pull_old_site.md.
3. `python -I scripts/rep-reports/build_rep_reports.py DATA_DIR OUT_DIR 2026-04-01 2026-10-14`

Use a new period folder name each time. Keep DATA_DIR outside the repo.

## Rules and traps
- Rep code names are hardcoded in `REPS`: Ostendo has no salesperson table. `-1` suffixes fold into the base code.
- Figures are invoice net (ex GST). Credits shown separately. Reversed invoices excluded (rep 490 differed by one credit, $871.78, from the earlier summary).
- Values are written as numbers, not formulas: no LibreOffice here, and phone previewers show uncached formulas as blank.
- **Online workflow (Pratham, 15 Oct 2026):** an online order (Shopify, old site, or an old-site order emailed in) is forwarded by admin to the rep, who re-keys it in Ostendo with their own discounts and then deletes the source order. The office also sometimes keys it under 450 and assigns the rep later. Amount-only matching therefore undercuts Online badly (Chris showed 2.7%, now 22.4%).
- Tier A: online order (Shopify or old site) with the same amount (0.5%) invoiced -1 to +14 days later. Tier B: the order's store (learned from tier A, or name tokens for Shopify) has an invoice 0 to +10 days later at 0.5x-1.6x the amount (re-keyed). Duplicate rule: same store, day and amount twice. One online order explains one invoice. Old-site logins map to Ostendo stores by exact-amount votes.
- Not provable: emailed-in old-site orders keyed by hand, and office-keyed 450 orders reassigned later, leave no trail. The Summary line "Rep / Phone at stores that also order online" sizes the possible extra.
- `SYSUSERCREATED` is the invoicing user, not the order source. Order "Created By" (XQS = online) exists only on the manual Order Screen export.
- Old-site order Total equals the Ostendo invoice net exactly for about 1,980 FY26 orders (synced as is).
- `GROUPORDERNUMBERS` starting with `S` is about 25% of invoices every month since 2025, before Shopify existed, so it is NOT an online flag.
- Corporate EDI = billed to Foodstuffs South Island Ltd only (`EDI_CUSTOMERS`). Region = billing city; Ostendo has no delivery address.
- The earlier hand-built Chris report showed 9% online; this build gives 22.4% with the old site included.
