# Rep reports (FY location and channel)

One Excel workbook per Ostendo rep code, same layout as the Chris (460) report. Requested by Kishan, 15 Oct 2026. Standing report: re-run to refresh.

Workbook pages: Start Here, Summary (online vs rep side by side), By Region (online vs rep per region plus chart, stores under each region), Online Orders, All Invoices, How We Worked It Out. Written for a 10 year old: plain words, no jargon.

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
- Phase 1 learns which old-site login / Shopify company is which Ostendo store, from near-exact amount matches (within 0.2%, -1 to +14 days). Stray single votes are ignored.
- Tier A (same amount): same store, amount within 0.2%, invoiced -1 to +14 days after the online order. Tier B (re-keyed): same store, invoice 0 to +10 days later at 0.5x-1.6x the amount. Duplicate rule: same store, day and amount twice. One online order explains one invoice. An amount match at a DIFFERENT store is a coincidence and is rejected (an earlier build that allowed this gave Chris 22.4% online; the store-checked figure is 12.3%).
- Generic words (Caltex, Four Square, Night n Day, Challenge...) never count as a store-name match (GENERIC in the script).
- Results must not depend on hash order: iterate sorted (an unsorted set made the region figures change between runs once).
- Regions (Ostendo has no delivery address): 1 directly billed store = its billing city; 2 Shopify portal delivery address when every word of the store name appears in the portal company name (107 of 120 agree with billing city, rest mostly the same region); 3 unambiguous town in the store name (AMBIGUOUS street-like names excluded); otherwise the group "Chain stores (town not recorded)". A chain head office billing city is NEVER used: Night n Day stores in Auckland and Wellington all bill from Dunedin.
- The script asserts channels, regions and invoice counts add up before saving. verify.py-style check: totals equal raw Ostendo sums per rep code to the cent.
- Not provable: emailed-in old-site orders keyed by hand, and office-keyed 450 orders reassigned later, leave no trail. The Summary line "Rep / Phone at stores that also order online" sizes the possible extra.
- `SYSUSERCREATED` is the invoicing user, not the order source. Order "Created By" (XQS = online) exists only on the manual Order Screen export.
- Old-site order Total equals the Ostendo invoice net exactly for about 1,980 FY26 orders (synced as is).
- `GROUPORDERNUMBERS` starting with `S` is about 25% of invoices every month since 2025, before Shopify existed, so it is NOT an online flag.
- Corporate EDI = billed to Foodstuffs South Island Ltd only (`EDI_CUSTOMERS`). Region = billing city; Ostendo has no delivery address.
- The earlier hand-built Chris report showed 9% online; this build gives 12.3% (store-checked, old site included).
