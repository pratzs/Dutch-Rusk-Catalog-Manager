# Catalog pricing: prices, compare-at, and the monthly deal sheet

Every catalog price lives in Shopify, on that catalog's price list. The app
only keeps BOGO deals (`app.bogo.jsx`). This document covers the two jobs that
keep the price lists right without anyone touching them.

## 1. Catalog prices follow retail (`catalog-reprice`)

**The problem it fixes.** Ostendo owns retail. When it changes a product price,
only the product moves. A catalog price is a fixed dollar amount, so it used to
stay put: on 5 Oct 2026 236 catalog prices were giving 13-18% off instead of
10%, 175 more had a compare-at that no longer matched retail, and 248 variants
had a stale PRODUCT-level compare-at (left by the manual compare-price button)
that the catalog sync read as "standard retail".

**The rule.** While a row is consistent, `compareAt == retail` and
`fixed == retail x (1 - p)`. When retail changes, compare-at is still the old
retail, so the intended percentage is `p = 1 - fixed / compareAt`, and:

    new fixed = round(new retail x (1 - p)),  new compareAt = new retail

Worked example: 10% off $31.70 is $28.53. Retail becomes $33.00, so the price
becomes $29.70. No state is stored for this; the intent is read from the row.

| Row | What happens |
| --- | --- |
| compare-at == retail | nothing |
| price is a clean 5% step off the old compare-at | repriced at the same % |
| price is a negotiated dollar amount (not a clean step) | price kept, compare-at refreshed |
| a live monthly deal price | price kept, compare-at refreshed |
| no compare-at, discounted | compare-at added |
| anything that looks like bad data | **held**, logged, not changed |

Held means: retail moved more than 30% against the old compare-at, or the price
is more than 40% under retail. Both were real: a Jack Links case at $25 against
$376 retail (a per-unit price on a shipper), and Cocolabu retail falling 82%
overnight. Silently repricing those would spread the mistake. Look for
`[catalog-reprice] HOLD` in the logs.

It also sets the product-level `compareAt` equal to `price` wherever one is set.

**Where it runs.**
- `webhooks.products.update.jsx` calls `POST /api/catalog-reprice {variantIds}`
  the moment Ostendo changes a product. That route reprices those variants,
  *then* triggers `api.catalog-price-sync`. The order matters: the sync used to
  be called from the webhook directly, ran in parallel, read the old prices, and
  its 8-minute lock then refused the second run.
- Render cron **Catalog Pricing** (hourly, `npm run cron:pricing`) calls the same
  route with `{mode:"maintenance"}`: reverts due deals, then sweeps every row.
  A webhook that never arrived is repaired within the hour.

Code: `app/lib/catalog-reprice.server.js`. Tests: `npm run test:pricing`.

## 2. The monthly deal sheet (`deal-sheet`)

A deal sheet arrives at the end of each month for General Catalog buyers.

1. Printed prices are **per single, ex GST**. Each variant's price is the
   single price x the singles in that pack size (Each 1, `Outer (12 Each)` 12,
   `Shipper (6 Outer)` 6 x the outer, a plain `Shipper` of "x 12ct" 12).
2. A line applies to the **whole group it names**: "Medium Bars Mars & Cadbury"
   is every single 39-50g Mars, Snickers, Twix, Bounty and Cadbury bar. Twin
   pack, kingsize, block, sharepack and pod are separate groups.
3. Whatever the sheet says is the price, even where its badge % disagrees.
4. Same product, same price.
5. "Buy 4+" lines are Shopify **quantity price breaks** on the price list. They
   apply per variant; different flavours do not combine.
6. Write them with `scripts/deal-sheet-apply.mjs rows.json --month YYYY-MM`
   (dry run first, then `--apply`). It records each row in `DealSheetPrice`.

**Putting it back on the 1st.** Each register row stores *what the price was*
as an intent, not a dollar amount, because retail moves during the month:

| `baseKind` | restored as |
| --- | --- |
| `pct` (was e.g. 10% off) | `round(retail now x (1 - pct))` |
| `none` (no fixed price) | the fixed price is deleted; the list is 0%, so retail applies |
| `custom` (negotiated $) | that dollar price |

The hourly job reverts every row past `endsAt` (00:00 NZ on the 1st; 11:00 UTC
the day before in NZDT). A deal price somebody changed by hand since is left
alone and noted in `revertNote`. Re-applying a variant that is already in the
register keeps the original base, so a sheet applied before the 1st never
mistakes last month's deal for "normal"; those rows simply move to the new month.

While a deal is live, the reprice job keeps its price and only refreshes its
compare-at.

Code: `app/lib/deal-sheet.server.js`. Table: `DealSheetPrice`
(migration `20261006000001_add_deal_sheet_price`).

### The Deals menu and badge

Every product on a sheet carries the Shopify tag `deal-sheet`, set when the
sheet is applied and removed on the 1st unless the product is on the next sheet.
Lines whose normal General price already is the deal price are registered as
`kind = "listing"` rows (no price change), so those products are tagged too.

- Collection **Deal Sheet** (`/collections/deal-sheet`), automated, rule
  "tag equals deal-sheet", published to the Online Store. The `deal-` handle
  prefix means the existing deal-access gate in `main-collection-product-grid`
  already blocks buyers who are not entitled.
- Menu: **Special Deals > Deal Sheet** in `main-menu`. The header hides the whole
  Special Deals item from buyers who are not entitled.
- Badge: `snippets/product-badge.liquid` in the theme shows "Deals" on tagged
  products, only for entitled buyers (the tag itself is public).

The menu item and collection are permanent; only the tags change each month.
`menuUpdate` replaces the whole tree, so any future menu edit must resend all of
it. A pre-change copy is in the backups folder.

## 3. Backups

Before any bulk change, snapshot every price list (fixed prices, compare-at,
quantity breaks) to a folder **outside** the repo (this repo is public). The
5 Oct 2026 snapshots are in `C:\Users\PrathamJani\dutch-rusk-backups`.

## Known gaps

- Calypso Island Wave retails at $54.90 in Ostendo, the other Calypso flavours
  at $47.65. Its General price was set to $42.88 (same as the others) as a
  fixed dollar price. Fix the retail in Ostendo; the reprice job then refreshes
  its compare-at.
- Carefree Tampons 100g Super Regular/Super Pro and the Nongshim Shin Cup were
  on the Oct 2026 sheet but are not in the store. Waiting on the team.
- 35 rows are held for review (Metromart 20, General 13, TEEG 2).
