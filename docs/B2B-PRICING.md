# B2B pricing: how the discount rows are produced, and what limits them

## The design in one paragraph

A Dutch Rusk B2B order has to show the saving as a real discount — a struck
through "was" price plus explicit **B2B Wholesale Price** rows on the cart, at
checkout, and on the order in the admin. Order **#1892** is the reference for
what correct looks like. Shopify's native catalog pricing gives the right
numbers but no discount rows, so two Functions run in a pair:

1. **`b2b-price-transformer`** (cart transform) raises every line from the
   catalog price up to the variant's `custom.standard_retail_price`.
2. **`b2b-custom-prices`** (product discount, the automatic discount "B2B
   Wholesale Custom Pricing") brings it back down to the buyer's catalog price.

The gap between the two **is** the customer-visible saving. BOGO deals live
inside the same discount Function, because this shop's checkout only ever runs
one active product-discount Function at a time.

## The thing that makes this fragile

Step 1 always succeeds. Step 2 can be killed for going over Shopify's **11M
instruction budget** — and when it is, prices have already been raised and the
buyer **pays full retail**. That is what happened to orders #1409, #1850 and
#1884.

The failure is *fail-open in the merchant's favour*, so nobody notices until the
money is already wrong. Two things guard against it:

- **`MAX_LINES_TO_TRANSFORM`** in `b2b-price-transformer/src/run.js`. Above this
  many cart lines the transform stands down entirely, which inverts the failure:
  the line keeps Shopify's own catalog price, which is correct. The cart still
  shows a struck-through "was" price (`sections/main-cart.liquid` falls back to
  `item.variant.compare_at_price`); it just loses the explicit discount row.
- **`webhooks.orders.create.jsx`**, which re-prices every B2B order against
  `contextualPricing` and tags anything wrong, plus the 15-minute
  `app/lib/pricing-health.server.js` check on the Function pair itself.

## Big carts: a shared budget instead of a line limit (LIVE 16 Nov 2026, app version 294)

**This replaces the fixed 108-line guard described further down.** Where the two
disagree, this section is current.

**What went wrong.** Night n Day stores started sending carts above 108 lines:
#3041 (120), #3283 and #3285 (119), #3331 (126), and earlier #2531 (142). Both
Functions stood down, so the orders were priced correctly at the catalog rate
but had no struck-through price and no discount rows. Simply raising the number
was not safe: #3331's real cart measured **11.54M** in the discount Function
against the 11M limit, which would have billed full retail.

**Where the cost was.** Measured on that cart: receiving it 2.86M, the loop
1.43M, and **building the discount rows 7.25M**. Each row is about 0.058M, nearly
all of it output. So the lever is output.

**The change, in three parts.**

1. *The discount Function shares entries.* Above 65 lines, every line with the
   same saving goes under ONE discount entry with many targets, and targets no
   longer carry a quantity (null means the whole line). #3331 has 126 lines but
   only 51 different savings: 11.54M became 8.71M. Each line still gets its own
   "B2B Wholesale Price" allocation. Grouping was tried in September with a Map
   and rejected because it cost more than it saved; a plain object with integer
   cent keys does not.
2. *The transform passes retail through as text* instead of parsing and
   re-formatting it. The sync writes it as plain 2dp text, so the bytes are
   already right. 9.94M became 9.43M on #3331.
3. *The limit is a budget, not a line count.* Both Functions walk the cart in
   order and add up what the pair will spend, in thousands of instructions:

   | | fixed | per cart line | per covered line | per different saving |
   | --- | --- | --- | --- | --- |
   | discount | 400 + 460 reserve | 26 | 27 | 46 |
   | transform | 250 | 26 | 52 | 0 |

   A line is raised and discounted only while both totals stay within
   `BUDGET` = 10,600. The first line that does not fit ends it; that line and
   everything after it keep the native catalog price with no row. The 460
   reserve pays for the (up to ten) volume-break lines that get a row of their
   own. Above 250 lines both still stand down, because nothing was measured.

**The constants and the walk must be identical in both files.** If they differ,
one Function covers a line the other does not: raised but not discounted bills
retail, discounted but not raised is discounted twice.
`tests/budget.test.js` checks agreement on 3,000 random carts.

**What it covers.** Typical carts (savings repeat): everything up to about 139
lines, then the transform's side of the budget tapers it: 160 lines covers 119,
200 covers about 95, 250 covers about 74. A cart where every saving is different
is covered less far (108 lines covers 94), which is the one place the old code
did better, and no real order has looked like that.

**Proof.**
- All 82 real B2B orders of 60+ lines since 1 June replayed through old and new
  code: **0 lines lose a row, 605 gain one, 0 change amount, 0 disagreements**
  between the two Functions. #3331 126 of 126, #3041 120 of 120, #3283 and #3285
  116 of 119 (the other 3 have no saving to show), #2531 127 of 142.
- Stress grid with `shopify app function run` (heaviest live strings, long line
  ids, ten volume-break lines, 66 to 250 lines, all-different and repeated
  savings): the highest figure in either Function is **10.05M**, 8.6% under the
  limit.
- 65 lines or fewer: the discount Function's output is byte-identical to before
  on 2,000 random carts, and the transform raises the same lines to the same
  prices.

**One property changed, knowingly.** Carts of 109 to 250 lines used to be immune
to a dead discount Function, because nothing was raised. They are now raised
like any other cart, so residual risk 1 below applies to them too. Dying from
cart SIZE is what the budget prevents.

**Checked live after the deploy** (version 294, rollback target 293), in a real
storefront cart as the Worthy Oceania staff buyer, no order placed:

| cart | lines with a "B2B Wholesale Price" row | wrong prices | raised but not discounted |
| --- | --- | --- | --- |
| 91 lines | 91 | 0 | 0 |
| 126 lines (67 different savings) | 125 | 0 | 0 |
| 170 lines | 110, one unbroken run, then 60 at catalog price | 0 | 0 |

The cart page shows the struck-through price and the row on each covered line.
The 126-line test cart lost one row where #3331 would lose none, because it
had 67 different savings against #3331's 51: the model is deliberately cautious.

**Still to check:** how a shared entry looks at checkout and on the order in the
admin. Compare the first 66+ line order after 16 Nov against #1892.

**The deploy also needed** `checkout-price-display` moved from api_version
2025-10 to 2026-01, because Shopify no longer accepts 2025-10. Config only; the
extension still uses the 2025.7 React library and needs a proper update before
2026-01 retires on 16 Jan 2027.

**Re-measure when** a catalog is added, the price strings grow, or either
Function's input query changes. Build, then
`shopify app function run --input <cart.json> --export run --json` in each
extension folder.

## Big-order edge cases checked 16 Nov 2026

Every B2B order since 1 Sept (1,270, of which 56 had 66+ lines, 5 had 109+,
the largest 142) was checked for what big carts do differently.

| edge case | found in real orders | state |
| --- | --- | --- |
| No discount rows above the old 108-line guard | #2531, #3041, #3283, #3285, #3331 | fixed, version 294 |
| The orders/create pricing guard never ran: it read the buyer's location from the GraphQL order shape, and the webhook sends the REST shape (`company.location_id`). No order was ever tagged `pricing-error` or `pricing-no-discount-rows`. | every order | fixed 16 Nov (commit 3ca0d90). Against the 36 B2B orders since the 14 Nov price update it flags exactly one, #3331 |
| Buy X Get Y deals never apply above 65 lines | #2246 (6 free units missed), #2980 (1), #3304 (1) | built and tested on branch `big-cart-deals`, **not shipped**, see below |
| Volume breaks honoured on only 10 lines above 65 lines | none: the most break lines in any real cart is 5 | same branch |
| Lines that looked billed above catalog on 9-13 Nov orders (Night n Day shippers, General trays) | #3196-#3316 | **not a fault**: each product's retail and catalog prices were updated on 13-14 Nov, after those orders. What was charged was Shopify's own catalog price at the time. Nothing since. |
| Over 250 lines (Functions stand down entirely) | none | unchanged |
| Order webhook price lookup on very large orders | tested to 250 variants in one query | fine (query cost 5) |

**Why deals on big carts are parked.** The branch sets deal lines aside during
the walk and prices them afterwards, only out of budget left over, so it can
never take a row away (replay of 82 real 60+ line orders: 0 rows lost; the
three orders above get their free units and each costs the customer less).
But measured on identical carts it runs 0.1-0.3M above version 294 even when
no deal applies to the buyer's catalog (every Night n Day cart: about 0.09M
of fixed cost from the larger code, about 0.12M from scanning the deal list),
and up to 0.8M above when deal lines are set aside but cannot be afforded.
Worst synthetic case 10.66M against the 11M limit, where version 294's worst is
10.05M. Over 11M bills full retail. Paying for it by lowering the shared
budget would take rows off #3331-sized carts. To ship it, first cut that
overhead (decide "does any deal apply to this catalog" in the app when the
deal list is saved, not in the Function on every cart; and cap the set-aside
lines lower), then re-measure on worst-case carts (all-different savings, longest price strings, many deal lines) against version 294 on the same inputs.

## Where the instructions actually go

Measured with `shopify app function run --input <cart>` inside
`extensions/b2b-custom-prices`, which prints Instructions against the limit.
Worst case = lines drawn from the largest live price strings, every line
matching a BOGO bundle, quantities set so all five deals activate.

Per phase, on an 80-line worst-case cart:

| phase | before | after | what changed |
| --- | --- | --- | --- |
| receive input | 4.14M | 3.10M | smaller input query, smaller deal config |
| per-line loop | 2.82M | 1.82M | parallel typed arrays |
| BOGO allocation | 3.49M | 0 above 65 lines | one pass over the cart, and skipped entirely on big carts |
| build + serialise output | 4.05M | 3.90M | integer-cents formatting |
| **total at 80 lines** | **14.50M** | **10.33M** | |

Two findings worth keeping, because they contradict what was previously
believed:

- The per-line `JSON.parse` of the old `custom.catalog_fixed_prices` map was
  **not** the main cost. Removing it saved about 12%, not the ~50% expected.
  The cost was spread across all four phases.
- **Output serialisation alone is ~2.2M** on an 80-line cart (~280 instructions
  per byte of output). That is a platform cost and cannot be optimised away, so
  the number of discount rows is itself a real constraint.

## Volume pricing (quantity price breaks), built 9 Oct 2026, NOT YET LIVE

**The gap.** A catalog can say "12+ of this variant costs $47.83 each" (Shopify
quantity price breaks). Shopify honours that natively, but the pair above sets
every line to "retail minus a fixed saving", and the saving did not depend on
quantity, so breaks never reached checkout. Found when Nishit enabled volume
pricing on the Metromart catalog (Bic Lighters Outer, 12+ at $47.83) and it did
nothing on the site. The October deal-sheet breaks (Calypso 4+, Warhead 3+,
General catalog) had the same limitation.

**The fix is data plus a few lines of Function code, not a third Function.**
`api.catalog-price-sync` writes each break into the price list's own entry:

```
+80.00|34505457977:18.80@12=32.17@24=36.00|
^flag            ^base   ^12+    ^24+          (savings off retail)
```

- The leading **`+`** marks a variant that has any break. The discount Function
  reads one character per line to learn that; only flagged lines pay for any break
  maths. `parseFloat("+80.00")` is 80, and `parseFloat("18.80@12=...")` is 18.8,
  so **a Function that has not been updated prices exactly as before**. The data
  can ship before the code, in either order.
- The discount Function takes the deepest saving whose break the line's quantity
  reaches. Breaks are per cart line, as Shopify's are. The transform is unchanged:
  it still raises to retail, and the saving is what comes back off.
- The row label stays **B2B Wholesale Price**.

**Guards.**
- A break more than 40% below the catalog's own price is treated as bad data and
  not shipped (`MAX_BREAK_DEPTH`). Real case: three Metromart Bic Lighters
  *Shipper* rows (a case of 12 Outers, $734.40) carried the Outer's "12+ at $47.83".
  They are skipped and logged `[volume-breaks] SKIPPED`. Remove them in Shopify.
- A break at or above the base price, quantity 1, or malformed text is dropped.
- A cart honours breaks on a limited number of lines (`tiersAllowed`: 40 lines
  or fewer allows 40, up to 65 allows 25, above that 10). Lines past it pay their
  normal catalog price. Never more than the catalog price; the alternative, running
  out of instruction budget, bills full retail.
- **`MAX_LINES_TO_TRANSFORM` is now 108 in both Functions (was 110).** Breaks cost
  about 0.14M instructions on a 110-line cart; two fewer lines give it back so the
  worst-case headroom is what it was. A 109 or 110 line cart now gets Shopify's
  native catalog price with no discount rows. The largest order ever taken is 104.

**Cost, measured with `shopify app function run` (limit 11M).** Heaviest live
strings, every line discounted, 5 deals on:

| cart | before | after, no breaks | after, every line has breaks |
| --- | --- | --- | --- |
| 40 lines | 4.93M | 5.02M | 6.52M |
| 65 lines | 7.73M | 7.84M | 8.82M |
| 65 lines, deals | 8.43M | 8.54M | 9.44M |
| 110 lines | 10.19M | 10.34M | 10.62M |

At the new 108 guard the 110-line figures drop by about 0.2M. A first version that
looked for "@" in every line cost 0.7M extra on plain carts and 14M with breaks on
every line; the flag character is what fixed that. Re-measure before raising any
limit.

**Keeping the data fresh.** `api.catalog-price-sync` reuses the break snapshot it
stored (`CatalogSyncState` row `BREAKS_SNAPSHOT`) unless `refreshBreaks` is set.
The daily sweep in `api.catalog-reprice` re-reads every price list's breaks,
compares with the snapshot, and starts a refreshing sync when anything changed
(also on the first run after deploy). The admin's "Full sync" button refreshes
them immediately. So a break added in Shopify reaches checkout within a day, or
straight away after a Full sync.

**Rollout order and rollback.**
1. Deploy the app (sync + route). Safe on its own: old Functions ignore the new data.
2. Run the sync once (it refreshes the breaks). Check a few `catalog_savings` values.
3. Deploy the Functions (`shopify app deploy --allow-updates`).
4. Price a real cart for a Metromart buyer: 11 Outers 61.20 each, 12 at 47.83.
Rollback: redeploy the previous app version; the data stays harmless. Tests:
`extensions/b2b-custom-prices/tests/volume.test.js`,
`parity-pre-volume.test.js` (byte-identical to the pre-volume Function on 4,000
random carts with no breaks), `app/lib/volume-breaks.test.mjs`.

## The two thresholds, and why

There are two, because deal allocation is much more expensive than the catalog
discount and is worth spending the budget on only while it can actually fire.

**`MAX_LINES_FOR_DEALS` = 65** (`b2b-custom-prices/src/run.js`). Worst case with
deals on: 60 lines 9.60M, **65 lines 9.96M (9.5% headroom)**, 70 lines 10.44M,
75 lines 11.05M (over). Above 65, deal allocation is skipped.

That takes nothing away from anyone. Deals only ever apply to lines the cart
transform raised, and the transform's guard has always stood down below this
size, so a cart that big gets no deal today either **and** no discount rows.
Skipping the deal maths is what pays for it to get the rows.

**`MAX_LINES_TO_TRANSFORM` = 110** (108 once volume pricing ships, see above), in BOTH Functions, and they must match.

The discount Function no longer receives the line cost, so it cannot work out for
itself whether the transform raised a line. Both read the same cart and apply the
same limit to the same line count instead, which is deterministic.

Measured 2026-09-16 against an honest worst case: heaviest live data, every line
discounted, and every line a DIFFERENT saving so no two discount rows can share
an entry.

| products | transform | discount (binding) | output (cap 19.53KB) |
| --- | --- | --- | --- |
| 105 | 7.94M | 9.50M | 14.29KB |
| **110** | **8.31M** | **9.94M** | **14.98KB** |
| 115 | 8.68M | 10.36M | 15.66KB |

110 leaves about 10% headroom on the binding side. **#1397 at 104 products is the
largest order this store has ever taken**, so 110 covers all of them.

The deals path, which is the expensive one, measures 8.42M at its own 65-product
threshold.

## How it got from 80 to 110: fewer FIELDS, not fewer bytes

**Every field in a Function's input query is charged on EVERY cart line, whether
or not the code reads it.** Skipping only the read saves nothing; the field has
to leave the query. That was measured twice and is the single most useful fact
in this document.

So each variant now carries one string, `custom.catalog_savings`:

```
27.75|34326937913:5.25|34326774073:4.25|#dragon-2kg-5-1|
^retail  ^price list : saving off retail      ^deals it is on
```

- The **saving** is stored rather than the catalog price, which is what lets the
  discount Function drop the line cost entirely: the amount it takes off IS the
  saving.
- **Deal membership** rides in the same string because the Function no longer
  receives the variant id it used to match on. `api.catalog-price-sync` writes
  those markers from the same config the BOGO admin page writes, so **editing a
  deal needs a sync to follow it**.

That takes the discount Function from five fields per line to three, and the
transform to two. Per-line cost fell from 0.125M to 0.076M.

Two things found while building it:

- **Above `MAX_LINES_FOR_DEALS` no deal can apply**, so allocating the per-line
  arrays the deal logic needs was pure waste on exactly the big carts the guard
  exists for. A single-pass fast path saves ~1.7M at 115 products.
- **Deal money is computed in whole cents.** The override lands on an exact half
  cent for some prices (13.85 at 10% is 1.385) and comparing floats there rounded
  the opposite way to the old code on 3 of 440 real orders, worth 3 to 4 cents
  each. Integers cannot drift.

A deal now applies only where the buyer's catalog actually discounts the variant.
That is the same protection the old per-line check gave, and erring this way can
only under-apply a promotion, never overcharge.

## How this was proven before it went live

- 23 unit tests pinning every money rule as a final per-unit price
- **All 440 real B2B orders replayed through both generations end to end: 440 of
  440 priced identically, no order total moved by a cent, 2 orders gained
  discount rows, none lost any**
- **2,701 of 2,701** discounted variants verified: retail, every saving and every
  deal marker agreeing exactly with the live price data, before the Functions
  were deployed

## There is a structural ceiling, and it is not far above the guard

Asked whether the cap could simply be removed for 150-200 line carts: **it
cannot**, and the reason is worth writing down because it is not a matter of
optimising harder.

A Function has **two** hard limits, not one: 11M instructions **and 19.53KB of
output**. Measured on real 104-line order #1397's lines, extended:

| lines | instructions (limit 11M) | output (limit 19.53KB) |
| --- | --- | --- |
| 104 | 15.27M | 14.17KB |
| 130 | 18.62M | 17.73KB |
| 150 | 21.14M | 20.46KB — **over** |
| 200 | 27.55M | 27.31KB — **over** |
| 250 | 34.05M | 34.15KB — **over** |

And the floor, with the Function body replaced by an immediate `return` so it
does nothing at all:

| lines | just receiving the cart |
| --- | --- |
| 150 | 6.31M |
| 200 | **8.30M of the 11M budget** |

So at 200 lines, three quarters of the budget is gone before a single price is
looked at. No rewrite recovers that.

The output limit is the more fundamental of the two. **Every "B2B Wholesale
Price" row is output bytes**, so the requirement to show a discount row per line
is itself what caps the cart size, at roughly 140 lines no matter how the code
is written. The cart transform hits its own wall too: it costs ~0.094M/line, so
200 lines would be ~19M on its own.

The only architecture with no cart-size ceiling is Shopify's native catalog
pricing with no Function in the pricing path — which is exactly what was tried
on 2026-09-07 and rejected, because it produces orders with no discount rows.
That trade is the real decision here: **discount rows on every order, or no
cart-size limit. Not both.**

A note on counting: the admin's item count on an order is **units**, not lines.
Order #1986 shows 150 but is 82 distinct lines; #1397 shows 400 but is 104
lines; #1993 shows 80 but is 51 lines. Function cost scales with distinct lines
— a line of quantity 22 costs the same as a line of quantity 1 — so the unit
count on the order screen is not the number that matters here.

## Catalog growth erodes the guard

Every extra customer catalog carrying genuine discounts adds an entry to the
price string on every variant, and that string is sent on every cart line.
**Re-measure the worst case before onboarding a new catalog**, and lower the
guard if needed.

## `custom.catalog_prices_v2`

Both Functions read the buyer's catalog price from a compact string on each
variant:

```
|34326708537:12.34|34326872377:9.10|
```

keyed by the numeric part of the price list id, delimited on both ends so a
lookup for `"|<id>:"` can never match the tail of a longer id. A variant with no
genuine discount anywhere gets a bare `"|"`. It is read with `indexOf` plus a
bounded `slice` — never `JSON.parse`.

`api.catalog-price-sync.jsx` writes it, alongside the older
`custom.catalog_fixed_prices` JSON map, which is kept because the (currently
inert) `b2b-catalog-discount` Function still reads it and because keeping it
means the Functions can be rolled back without a data migration.

> An earlier attempt at a hand-rolled scan measured **slower** than `JSON.parse`
> because it indexed the string character by character, which allocates in
> QuickJS. `indexOf`/`slice` are native and do not.

## Deploy order matters

The new Functions read two things that do not exist until the app has written
them: `custom.catalog_prices_v2` on every variant, and `custom.bogo_fn` on the
discount node. Deploying the Functions first would leave every variant without a
catalog price — the transform would stand down, prices would stay correct at
Shopify's native catalog rate, but **every** order would lose its discount rows
until the sync caught up.

1. Deploy the web app (carries `api.catalog-price-sync.jsx` and `app.bogo.jsx`).
2. Run a full catalog sync, and confirm `catalog_prices_v2` is populated.
3. Save the BOGO page once (or write the metafield directly) so `bogo_fn` exists.
4. Verify both.
5. Only then `shopify app deploy --allow-updates` for the Functions.

Nothing in steps 1-4 disturbs the live Functions: the sync still writes the old
`catalog_fixed_prices` map, and the compact deal config goes to a **new** key
(`bogo_fn`) rather than replacing `bogo_bundles`, which the currently live
Function is still reading. Without that split, step 3 would silently switch every
deal off until step 5 landed.

## What is pinned by tests

`extensions/b2b-custom-prices/tests/pricing.test.js` (18 tests) states every
money rule as a **final per-unit price**, and `tests/anysize.test.js` states the
safety property: no cart size is ever charged above catalog, including when the
discount Function is dead. Both must stay green.

The other four test files need `AUDIT_DATA_DIR`, an external audit dump that is
no longer on disk; they fail to collect without it.

## Known residual risks

1. If the discount Function dies for a reason other than cart size (deploy gap,
   deactivated discount, crash), orders under the guard still bill full retail.
   Monitoring catches it after the money is wrong, not before.
2. Carts above the guard keep correct prices but lose the explicit discount row.
3. Draft/manual B2B orders bill retail — drafts skip the discount Function
   entirely, so never test B2B pricing with a draft order.
