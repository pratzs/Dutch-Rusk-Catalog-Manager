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

**What a held row looks like to the customer (7 Oct 2026).** A held row's
compare-at no longer matches retail, so it would be a false "was" price. The
repricer **clears** it (the price is untouched; the write must pass
`compareAtPrice: null`, leaving the field out keeps the old value) and records
the row in `HeldPriceRow` with the compare-at it had. Each later check feeds
that remembered compare-at back through the same rule, so once retail is fixed
in Ostendo the row resolves on its own: compare-at is restored, or the old % off
is re-applied to the new retail. If someone changes the price by hand the
record is dropped. A held row with no compare-at is simply listed.

**Daily held-rows email.** After the daily sweep, `sendHeldReport` emails
`PRICING_ALERT_EMAIL` the held rows in two groups: price more than 40% under
retail (often a per-unit price on a whole case: needs a price decision) and
retail moved more than 30% (check Ostendo). No held rows, no email.

It also sets the product-level `compareAt` equal to `price` wherever one is set.

**Where it runs.**
- `webhooks.products.update.jsx` calls `POST /api/catalog-reprice {variantIds}`
  the moment Ostendo changes a product. That route reprices those variants,
  *then* triggers `api.catalog-price-sync`. The order matters: the sync used to
  be called from the webhook directly, ran in parallel, read the old prices, and
  its 8-minute lock then refused the second run.
- Render cron **Catalog Pricing** (hourly, `npm run cron:pricing`) calls the same
  route with `{mode:"maintenance"}`. Every hour it reverts due deals, switches
  BOGO and re-sorts the Deals page. The full price sweep inside it runs **once a
  day at 03:xx NZ** (Ostendo rarely changes prices and the webhook handles each
  change at once); `{mode:"maintenance", sweep:true}` forces one. A webhook that
  never arrived is repaired by the next daily sweep.

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

### The Deals on the Special Deals page, and the badge

Every product on a sheet carries the Shopify tag `deal-sheet`, set when the
sheet is applied and removed on the 1st unless the product is on the next sheet.
Lines whose normal General price already is the deal price are registered as
`kind = "listing"` rows (no price change), so those products are tagged too.

- **Special Deals page** (`/pages/special-deals`): the BOGO offer cards come first,
  exactly as before, then a **Deals** section with the deal-sheet products. The
  second part is the theme section `sections/deals-products.liquid`, added to
  `templates/page.special-deals.json` below the BOGO section. It renders the
  `deal-products` collection with the normal product card, quick add, stock map and
  "Show more" pagination. The Special Deals menu item is a plain link, no dropdown.
- Collection **Deals** (`/collections/deal-products`): automated, rule
  "tag equals deal-sheet", published to the Online Store. The `deal-` handle
  prefix means the deal-access gate on collection pages blocks buyers who are not
  entitled. Its order (sold-out last) is maintained by the app.
- Badge: `snippets/product-badge.liquid` shows "Deals" on tagged products, only
  for entitled buyers (the tag itself is public).
- Gate: the page and the new section both use `snippets/deal-access.liquid`
  (server side, fails closed). The header hides Special Deals from buyers who are
  not entitled.

**301 redirect.** The first version of this was a standalone page at
`/collections/deal-sheet`. When the Deals products moved onto Special Deals, that
address got a 301 to `/pages/special-deals` (Shopify redirect id
606819451193). Shopify ignores a redirect on a path that still has a live
collection, so the collection's handle was renamed to `deal-products` first
(keeping the `deal-` prefix so the access gate still applies). **Rule: whenever a
storefront page or collection address changes or is retired, create a 301 from
the old address.** The Catalog Manager cannot do this itself (its token has no
navigation scope); use the Shopify admin (Content > Menus > URL redirects) or the
Shopify connector's `urlRedirectCreate`. The BOGO deal collections
(`deal-<bundle id>`) are deleted by the BOGO page when a deal is removed, and
that address now gets a 301 to Special Deals too: the BOGO page queues it in the
shop metafield `custom.pending_redirects` and tries to create it straight away;
the hourly job retries whatever is still queued (`app/lib/redirects.server.js`).

**Known blocker.** Creating a redirect needs the `write_online_store_navigation`
access scope, and releasing a new scope needs `shopify app deploy`. That deploy is
currently refused because the `checkout-price-display` checkout extension is on
API version 2025-07, which Shopify no longer accepts ("Version couldn't be
created"). It has to be upgraded (and the checkout re-tested) before any app
deploy, scope or Function, will go through. Until then the queue simply waits, and
the monthly routine flushes it through the Shopify connector: read
`custom.pending_redirects`, `urlRedirectCreate` each one, then clear the queue.

The collection and page are permanent; only the tags change each month.
`menuUpdate` replaces the whole tree, so any future menu edit must resend all of
it. A pre-change copy of the main menu is in the backups folder.

### BOGO deals run only in the months a deal sheet lists them

Rule from the business (6 Oct 2026): a BOGO offer applies only in months the deal
sheet mentions it. **Dragon (2kg and Novelty) and Bundaberg run all year.** Every
other BOGO is switched on for its month and off after.

- `custom.bogo_master` holds every bundle with a `months` list (`["2026-11"]`;
  absent = all year; `[]` = off). The BOGO Bundles page edits this.
- `custom.bogo_bundles` holds only the bundles active this month. The theme badge,
  the Special Deals page, the deal access list and the catalog sync all read this
  key, so none of them changed.
- The same active set is written to the checkout Function config
  (`bogo_fn` and the legacy `bogo_bundles` on the pricing discount). A deal that
  is off is simply not in the Function's config, so it cannot apply at checkout.
- The hourly Catalog Pricing job runs `reconcileBogo`, so a deal switches on or
  off at 00:00 New Zealand time when the month turns. It writes nothing when
  nothing changed, and triggers the price sync when it did (the per-variant deal
  markers follow).
- Adding next month's deal: BOGO Bundles page, set "Months this deal runs".

Code: `app/lib/bogo-schedule.server.js`.

### Sold-out products on the Deals page

`SOLD_OUT_LAST_HANDLES` in `brand-order.server.js` lists collections whose
sold-out products sink to the bottom (just `deal-products`). "Sold out" means no
variant has `availableForSale`, the same test as the storefront badge. The
48-hour ordering job honours it, and the hourly Catalog Pricing job re-arranges
the Deals collection too, because stock moves faster than every 48 hours. Add a
handle to the list to extend it to another collection.

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
