# Browsing, vendors and deal access — how it works end to end

**Status:** Live
**Owner:** Pratham (Worthy)
**Last updated:** 10 September 2026
**UAT:** `Dutch_Rusk_FULL_Launch_UAT_Tracker_v4.xlsx` — Issues Log BUG-069 to BUG-083, test cases THEME-17 to THEME-22 and CAT-30 to CAT-33

This covers how product order, product vendors and BOGO deal access work on
b2b.dutchrusk.co.nz, why each piece sits where it does, and how to check any of
it. Two repositories are involved:

| Repo | What it holds |
| --- | --- |
| `pratzs/Dutch-Rusk-Catalog-Manager` | the scheduled job and all the logic (this repo) |
| `Worthy-Technology/WorthyProductsSouthWebsite` | the theme. `main` deploys straight to the live storefront |

---

## 1. The one rule behind all of it

**Nothing that decides what a buyer sees runs in the browser.**

It used to. Two features were built in theme JavaScript and both produced
customer complaints:

- **Brand grouping** re-sorted the product grid after the server had already
  sent it, and on every infinite-scroll page inserted the new cards back up
  into a brand block the shopper had scrolled past, then tried to hold the
  viewport still with `window.scrollBy()`. Kat Prest reported the site
  "takes forever to get through it as it stalls and then jumps way back up the
  page". Five commits tried to perfect that compensation. None could: adding
  content above the viewport either moves the page or depends on measuring the
  shift perfectly at the same moment the browser's own scroll anchoring is
  doing the same job.
- **The Special Deals menu gate** hid the item with CSS and revealed it with
  JavaScript after calling this app, so the answer arrived after paint and
  depended on the app being reachable.

Both are gone. Product order is a collection setting, and deal access is
decided in Liquid. If you are ever tempted to reorder, insert into or remove
from a product grid after render, that is the thing that caused the complaints.

---

## 2. Product order

### Where it lives

Every collection is on **manual sort order**, and the positions are maintained
by a scheduled job. Shopify has no sort-by-vendor option at all — the choices
are manual, best-selling, alphabetical, price, date and relevance — so manual
order is the only way to group by brand.

Alphabetical was tried first and rejected: **70% of the 1,511 products have
titles that lead with their own brand**, but the rest do not, and the two that
matter most are "47g Mars Salted Caramel" and "50g Bounty". Both are vendor
Mars and both are tagged Mars Single Bars, yet one title starts with a digit
and the other with a B, so no alphabetical sort can ever put them together.
Sorted by vendor they end up two apart.

### The order, for every collection except the Shop page

1. **Vendor**, ranked by where that vendor first appears in that collection's
   own `BEST_SELLING` order. The best-selling brand leads and a brand's
   products sit together.
2. **Size band** within the brand, from `sizeBand()`:

   | Band | What |
   | --- | --- |
   | 1 | single bars |
   | 2 | share and king size |
   | 3 | blocks |
   | 4 | sharepacks |
   | 5 | bags up to 350g — the small family bags |
   | 6 | bags 500g and 800g |
   | 7 | bags 1kg and 2kg — bulk bags |
   | 8 | M&M bags, so they finish the Mars block |
   | 9 | anything unrecognised |

   Bags are banded by the **weight parsed from the title**, not by tag,
   because the tags disagree with reality: 25 products tagged "Bulk Gummies and
   Lollies" are 220g family bags, one "Family Bags" is a 1kg and one
   "Bulk Bags" is small. The first weight in a title is the pack, not the case:
   "Pascall Family Bag Marshmallows 180g x 12ct" is 180g.
3. **Title**, only so the result is stable and repeatable.

**New Arrivals is deliberately excluded** (`LEAVE_ALONE`). Brand-grouping it
would destroy the only thing that collection exists to show.

### The Shop page is different

`/collections/all` is Shopify's virtual all-products listing. It is **not a
collection**, so it has no sort order and cannot be ordered from the admin.
The Shop menu item therefore points at a real collection, **`shop-all`**, which
matches every product and is published to the same six publications as
Quick Order.

Shop All is the one collection ordered **by category first**, then vendor, then
size, then title, because it is the browse-the-whole-catalogue page:

```
Gum → Chocolate Bars → Chocolate Blocks → Chocolates → Novelty →
Family Bags → Bulk Gummies and Lollies → Bulk Bags → Lollipops → Licorice →
Snacks → Chips → Cookies → Popcorn → Noodles → Luncheon Meat →
Soft Drinks → Energy Drinks → Protein Drinks → Protein Bars → Health →
Toys → Batteries → Lighters → Smoking Accessories → Charging Cables →
Air Fresheners → Seal Bags → Laundry Detergent → (no category tag)
```

Three of those are ordering rules only and do **not** rewrite the stored
product type, so they are reversible by editing `CATEGORY_ORDER` and
`shopBucket()`:

- **Sharepacks** is not a bucket of its own. A sharepack belongs with its brand,
  so it browses in the chocolate section and lands at the end of that brand's
  chocolate.
- **Sour** is a flavour, not a size. A 1kg or 2kg sour bag browses with the bulk
  bags; a small one browses with the novelties. Because each bucket is then
  grouped by vendor, small sour items sit beside that brand's novelty items
  rather than forming a Sour block. That is intended.
- **M&M bags** get band 8 so they finish the Mars block instead of landing
  mid-brand on weight alone.

### How to change the order

- **A different category sequence:** edit `CATEGORY_ORDER` in
  `app/lib/brand-order.server.js`.
- **A different size banding:** edit `sizeBand()`.
- **A collection that should not be touched:** add its title to `LEAVE_ALONE`.
- **Brand precedence:** it is not a list. It comes from each collection's own
  best-selling order, so it follows real sales and needs no maintenance.

---

## 3. Product vendors

Brand grouping is only as good as the `vendor` field, and it was wrong on 136
products.

### The three problems found

| Problem | Count | Example |
| --- | --- | --- |
| Filed under the house vendor with the brand in the title | 69 | "Ajax Spray N Wipe" was vendor DutchRusk |
| Filed under a **wrong real** vendor | 33 | every Extra, Eclipse, 5 Gum, Hubba Bubba, Juicy Fruit and PK was Mars; they are Wrigley's |
| Brand only visible on the **product photo** | 34 | "Flat Lollipop Monster" is Florestal; "Dusky Lunch Snack Bag" is a Bluebird multipack |

That third group is why the images were reviewed one at a time. No title
parsing could have found them, and the same exercise confirmed what is
genuinely unbranded — Fruit Nut Mix's label literally reads "DUTCH RUSK LTD,
14 Echodale Place, Nelson".

Result: vendors went from 150 to **184**, house vendor from 231 to **128**.

### The rule, which runs on every scheduled pass

`normaliseVendors()` has two strengths deliberately:

- **`VENDOR_ALIASES` is authoritative.** It applies whatever the product's
  current vendor is, because gum-under-Mars was a *wrong* real vendor, not a
  missing one.
- **Matching against vendors that merely exist elsewhere only ever promotes**
  a product off the house vendor. It never overrides a real brand someone set
  deliberately.

So the worst case for any product is that nothing happens to it, and no brand
can be invented.

**The brand must appear at the START of the title**, allowing a leading weight
like "44g". Matching anywhere in the title was tried and produced nonsense:
"Toy With Candy - Flashing Carousel" became vendor Carousel, "Flat Lollipop
Monster" became Monster, "Toy - Sticky Poo Rainbow" became Rainbow and
"Toy - Tic Tac Toe" became Tic Tac. Anchoring rules all four out and loses no
real case — and it is why "Mars - 120g Maltesers Extra Choc" correctly stays
Mars rather than becoming Wrigley's.

### To add a brand

Add one line to `VENDOR_ALIASES` in `app/lib/brand-order.server.js`, keyed on
the lowercased start of the title. The next run applies it and keeps it.

---

## 4. Product types

Product type was blank on **all 1,511** active products. It is now filled on
1,292 of them (86%, 31 categories), derived from the category tags that already
existed — ignoring brand tags, operational tags (`hide-shipper`) and temporary
tags (`New`).

**Known gap, UAT BUG-083:** the scheduled job does *not* yet maintain product
type. Anything new arriving from Ostendo has no category and sorts to the end
of the Shop page until someone tags it. The fix is the same pattern as the
vendor rule and has been offered.

**Known gap, UAT BUG-082:** 219 live products have no category tag at all.
Their tags are brand names, operational flags or nothing. That is the admin
team's tagging; once tagged they are placed on the next run with no code change.

---

## 5. BOGO deal access

### The problem

All five deals target **General Catalog's price list only**, so the discount
would never have applied at checkout for anyone else. But the deal *pages* were
open: a Night N Day buyer could open `/collections/deal-musashi-10-1` and browse
Buy 10 Get 1 Free offers, and reach `/pages/special-deals`.

Hiding a menu item is not access control, because the URL still works.

### Why it is done in Liquid and not by catalog

Shopify **refuses** to publish a collection to a company-location catalog:

> Cannot publish a collection to a publication that does not belong to a
> channel catalog

Only products can be catalog-scoped. The deal collections therefore have to
stay on the Online Store publication, and Liquid has no way to ask which
catalog a buyer is on. So entitlement is precomputed by this app and read by
the theme.

### The mechanism

1. `syncDealLocations()` reads the deal targets from shop metafield
   `custom.bogo_bundles` (the same config the BOGO Bundles admin page and the
   checkout Function use), then walks every company location in Shopify and
   collects those whose catalog a live deal targets.
2. It writes them to shop metafield **`custom.deal_location_ids`** as a
   comma-wrapped list, `,123,456,`, so Liquid's `contains ",123,"` cannot match
   a partial id. The definition has `storefront: PUBLIC_READ` so Liquid can
   read it.
3. `snippets/deal-access.liquid` in the theme answers `true` or `false` for the
   current buyer, and four places use it:
   - the deal collection pages, in `sections/main-collection-product-grid.liquid`
   - the Special Deals page, in `sections/special-deals.liquid`
   - the menu item, in `sections/header.liquid`, `snippets/header-drawer.liquid`
     and `sections/footer.liquid`

**Fails closed.** A retail visitor, a buyer with no location, or a missing
metafield all read as not entitled, because showing someone a deal they cannot
have is the worse mistake. If the deal config is missing or unreadable the
existing allowlist is left alone rather than emptied, because emptying it would
revoke the deals from everyone.

Computed **live from Shopify**, not from this app's `LocationCatalogMap` cache.
That choice proved itself immediately: the cache-derived list had 479 locations
and the live one has 474 — six were locations deleted from Shopify and one
entitled location was missing from the cache entirely.

### What follows Ryan automatically

| Ryan changes | Applies |
| --- | --- |
| which catalogs a deal targets | next scheduled run |
| a customer moved onto or off General | next scheduled run |
| a deal added or removed | Special Deals page immediately, entitlement next run |
| products in a deal collection | immediately |
| discount behaviour at checkout | immediately, unchanged |

**The limit is timing:** the job runs every second day, so entitlement changes
can take up to ~48 hours. Splitting entitlement onto an hourly job has been
offered; it is a handful of API calls versus ~2.5 minutes for the ordering pass.

---

## 6. The scheduled job

| | |
| --- | --- |
| Render service | `crn-dagt5q3l550s73ecg44g` — "Collection Brand Order" |
| Schedule | `0 15 */2 * *` — 03:00 New Zealand, every second day |
| Command | `npx prisma generate && node scripts/brand-order.mjs` |
| Logic | `app/lib/brand-order.server.js` |
| Manual trigger | `POST /api/collection-brand-order` with header `x-cron-secret` |

Order of work in a run: **vendors first**, then the deal allowlist, then the
collection ordering — because the ordering groups by vendor and would otherwise
place a mis-filed product in the wrong block and need a second pass.

A collection already in the right order is detected and **written to zero
times**, so a quiet run takes about 2.5 minutes and changes nothing. The script
exits non-zero if any collection fails, so Render reports a broken pass as a
failure rather than a clean run.

### Two things that will bite you

**Do not make the cron curl the endpoint.** A full pass takes minutes and
Render ends a request that has sent nothing for 100 seconds, so a curl-based
cron gets cut off part way through and leaves collections half ordered. The
cron runs the script directly for that reason. The endpoint remains for manual
runs.

**Render already wraps `dockerCommand` in a shell.** Wrapping it in `sh -c`
yourself makes it try to exec the whole string as a filename:

```
sh: npx prisma generate && node scripts/brand-order.mjs: not found
```

The image installs prisma as a production dependency but does not generate the
client at build time — the web service does that at runtime in its own start
command — so the cron must run `npx prisma generate` first.

---

## 7. How to verify each thing

| Claim | Check |
| --- | --- |
| Brands are grouped in a collection | read the collection's products in storefront order and confirm each vendor is one contiguous block. Chocolates: 11 brands, 0 split. |
| The Shop page follows the category sequence | read `shop-all` in storefront order and note where each product-type block starts and ends |
| Ordering is idempotent | run the job twice; the second must report everything already correct and write nothing |
| Vendors are right | for any product, compare `vendor` against the brand at the start of the title, and against the pack in the product image |
| Pack-size policy is intact | for a sample of products, compare the rendered pack sizes against `publishedOnPublication` for that catalog's publication. Do not compare against how the theme used to behave. |
| A deal is blocked correctly | temporarily remove one test location from `custom.deal_location_ids`, load the deal collection, the deals page and any page's menu, then restore. Do not infer it from the code. |
| The page does not jump | park at a fixed scroll position, trigger two page loads without scrolling, and assert zero upward movement and zero cards moved or removed after paint |

---

## 8. Two failure modes worth remembering

**A collapsed sort looks exactly like a no-op.** Ordering the Shop page by
category reported "0 rearranged, 91 already correct, 0 failed" while 1,834 of
1,840 positions were wrong. The products query selected `id title vendor tags`
but not `productType`, so every product read as having no category, they all
tied on the primary key, the comparator fell through to the next key, and the
result was identical to the previous order. A missing GraphQL field does not
throw. When a sort seems not to take effect, compute the target independently
and diff it against live — a unit test of the comparator passes regardless,
because you hand it complete objects.

**A section file that Shopify rejects leaves the old version live.** The
Special Deals gate shipped doing nothing while the collection and menu gates
worked. The whole section had been wrapped in the condition, which left
`{% stylesheet %}` and `{% schema %}` inside a Liquid branch; Shopify requires
those at the top level, so the file was never applied. Same snippet, same
metafield, code simply not running. Test the blocked path, not the deploy.

---

## 9. Open items

| UAT | Item | Owner |
| --- | --- | --- |
| BUG-081 | 866 of 1,475 company locations have no catalog, so those buyers see no prices and cannot order | Dutch Rusk (Ryan) + Worthy |
| BUG-082 | 219 live products have no category tag, so they sort to the end of the Shop page | Dutch Rusk admin team |
| BUG-083 | the scheduled job does not maintain product type, so new products drift to the end of the Shop page | Worthy — fix offered |
| — | the old JavaScript deals menu gate in the app extension is now redundant, and hides the item by CSS until the app answers, so an entitled buyer loses the link if the app is briefly unreachable. Removing it needs an extension deploy. | Worthy — fix offered |
| — | the price-sync cron `crn-d876vsi8qa3s73d1cd90` is suspended | Worthy — decision needed |

---

## 10. Commit trail

**Theme** (`Worthy-Technology/WorthyProductsSouthWebsite`)

| Commit | What |
| --- | --- |
| `f52b9a9` | stop the card offering a pack size that is sold out |
| `851a525` | remove Locksmith, uninstalled and deciding nothing |
| `b89f09f` | stop reordering product cards in the browser |
| `78d96be` | block the BOGO deals for buyers the deals do not apply to |
| `b5c137f` | fix the Special Deals page gate, which never took effect |

**App** (`pratzs/Dutch-Rusk-Catalog-Manager`)

| Commit | What |
| --- | --- |
| `95fc9b6` | keep collections arranged by brand, from the admin, on a schedule |
| `8d12843` | run the brand ordering from a cron script, not over HTTP |
| `e77a488` | correct product vendors on every scheduled run |
| `b0924f9` | put the gum under Wrigley's, and band bags by real weight |
| `4f65323` | assign the vendors that only the product photos revealed |
| `c860600` | order the Shop page by category, brand within each category |
| `10cc264` | maintain the deal allowlist on every scheduled run |
