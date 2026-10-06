# Monthly deal sheet: what to do when the PDF arrives

At the end of each month the business sends the next month's deal sheet as a
PDF. This is the whole job, start to finish, with every rule agreed so far. The
mechanics are explained in `docs/CATALOG-PRICING.md`; this is the checklist.

**Never put sheet prices in this repo.** It is public and the prices are
General-catalog wholesale pricing. Working files live in
`C:\Users\PrathamJani\dutch-rusk-backups\` (`deal-sheets\YYYY-MM.lines.json`).

## The rules (all agreed with the business)

1. **Sheet prices are per single, ex GST.** A variant's price is the single price
   x the singles in that pack size (`Each` 1, `Outer (12 Each)` 12,
   `Shipper (6 Outer)` 6 x the outer, a plain `Shipper` of "x 12ct" = 12).
2. **The printed price wins**, even if the badge % disagrees or the price is above
   retail. Flag it in the report, do not change it.
3. **A line applies to the whole group it names.** "Medium Bars Mars & Cadbury" is
   every single 39-50g Mars, Snickers, Twix, Bounty and Cadbury bar. Twin pack,
   kingsize, block, sharepack and pods are separate groups, priced only when the
   sheet names them. "All varieties" means every variant.
4. **Same product, same price.** Always.
5. **Every price is a Shopify General catalog price** (price list
   `gid://shopify/PriceList/34326708537`). Only BOGO offers live in the app.
6. **"Buy 4+" lines are Shopify quantity price breaks** (per variant; flavours do
   not combine), not BOGO.
7. **Every deal price goes back on the 1st.** The register (`DealSheetPrice`) and
   the hourly Catalog Pricing job do this by themselves, and restore the previous
   percentage off *current* retail, not an old dollar amount.
8. **BOGO offers run only in months the sheet lists them.** Dragon 2kg, Dragon
   Novelty and Bundaberg run all year (leave "Months" blank). Everything else is
   set to the sheet's month, and any BOGO the sheet does not list stays off.
9. **Products the team cannot match** (not in the store, wrong name) are left alone
   and listed for the business to confirm. Do not guess a substitute.

## Steps

**0. Check you are on the right store.** The Shopify connector must report
`DutchRusk` from `get-shop-info` (it was once pointed at a testing store).

**1. Read the PDF.** Look at every page. For each line note: the product group,
the printed price, the badge %, any "Buy N+" offer, "all varieties", and any BOGO
(Buy X Get Y) offer. Pages repeat; count each once.

**2. Write `deal-sheets\YYYY-MM.lines.json`** (format at the top of
`scripts/deal-sheet-plan.mjs`; `2026-10.lines.json` is a worked example of a full
sheet, including a quantity break and a group line). Use `baseUnitsFromTitle` when
one line covers products with different pack counts.

**3. Plan, read, fix.**

    node scripts/deal-sheet-plan.mjs C:/Users/PrathamJani/dutch-rusk-backups/deal-sheets/YYYY-MM.lines.json

It writes `.plan.csv` and `.rows.json` and changes nothing. Read the summary and
the flags: no product found, same product at different prices, above retail,
badge mismatch, more than 40% off. Sanity check: a sheet's price is usually
retail x (1 - badge). Fix the `lines.json` (usually the `match` regex) until the
only remaining flags are real findings, then **send the business the findings**
(not the whole table): lines with no product, prices that look wrong, anything
above retail.

**4. Back up, then apply.** Snapshot first, outside the repo:

    node scripts/backup-price-lists.mjs C:/Users/PrathamJani/dutch-rusk-backups/pre_YYYY-MM_deals.json
    node scripts/deal-sheet-apply.mjs <rows.json> --month YYYY-MM             # dry run, read it
    node scripts/deal-sheet-apply.mjs <rows.json> --month YYYY-MM --apply

**When to apply.** New prices should start on the **1st**. Apply after the hourly
job has reverted the old month (it runs at :37, so from about 00:40 NZ on the
1st). Applying earlier makes the new prices live while the old month is still
running. The tool also moves any product already in the register to the new
month, so it never mistakes last month's deal for "normal".

**5. BOGO.** On the BOGO Bundles page set "Months this deal runs" for each BOGO
the sheet lists (`YYYY-MM`); leave Dragon 2kg, Dragon Novelty and Bundaberg
blank; check every other BOGO is off for the month. The hourly job switches them
at 00:00 NZ on the 1st. A new BOGO needs its products and catalog (General).

**6. Verify from Shopify, not from the script's own output.**

    node scripts/deal-sheet-verify.mjs <rows.json>

Then look at the page as a General customer in Chrome (signed in): the Special
Deals page shows the BOGO cards first, then the Deals products with the badge,
sold-out last. Do not add anything to the customer's cart while testing.

**7. Housekeeping.** Run the hourly job once
(`POST /api/catalog-reprice {"mode":"maintenance"}` with the cron secret) to
sort the page and reconcile BOGO. If a BOGO deal was removed, flush its queued
redirect (see below). Update the memory notes and this runbook if a rule changed.

**8. Report to the business in plain words:** how many products and prices
changed, what is on and off for BOGO, what could not be matched, anything above
retail or looking wrong, and when the prices end.

## Things that bite

- `menuUpdate` replaces the whole menu. Never edit a menu without resending all of
  it; copy in `dutch-rusk-backups\main_menu_before_deal_sheet_*.json`.
- **301 rule:** whenever a page or collection address changes or is retired, the
  old address gets a 301. Shopify ignores a redirect on a path that still has a
  live page, so rename or delete first. The app cannot create redirects (no
  navigation scope); a removed BOGO deal queues its redirect in the shop metafield
  `custom.pending_redirects`. Flush it through the Shopify connector
  (`urlRedirectCreate`, target `/pages/special-deals`) and clear the queue.
- **App deploys are blocked** until the `checkout-price-display` checkout
  extension is upgraded off API version 2025-07 (Shopify refuses the version).
  This also blocks the redirect permission. Not part of the monthly job.
- Calypso Island Wave retails higher than the other Calypso flavours in Ostendo.
  Its General price is a fixed $42.88 matching the others; the retail should be
  fixed at source.
- Held rows (Metromart, TEEG, General where retail moved a lot) are listed in
  `dutch-rusk-backups\compare_at_fix_HELD_for_review.json`; they are data
  problems, not deals.
- The hourly job logs `[catalog-reprice] HOLD` for anything it will not change.
  Silence from a Render cron proves nothing; check its log line.

## Where things are

| What | Where |
| --- | --- |
| Plan, apply, verify, backup scripts | `scripts/deal-sheet-*.mjs`, `scripts/backup-price-lists.mjs` |
| Engine | `app/lib/deal-sheet.server.js`, `catalog-reprice.server.js`, `bogo-schedule.server.js`, `redirects.server.js` |
| Hourly job | Render cron "Catalog Pricing" `crn-db21vtjbc2fs73eu4ln0`, `npm run cron:pricing` |
| Tests | `npm run test:pricing` |
| Deals page | `sections/deals-products.liquid` + `templates/page.special-deals.json` in the theme repo |
| Deals collection | `/collections/deal-products` (tag `deal-sheet`) |
| Working files and backups | `C:\Users\PrathamJani\dutch-rusk-backups\` |
