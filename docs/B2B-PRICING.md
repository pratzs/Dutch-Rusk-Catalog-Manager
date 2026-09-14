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

**`MAX_LINES_TO_TRANSFORM` = 80** (`b2b-price-transformer/src/run.js`).

Measured 2026-09-15 against an honest worst case: lines drawn from the heaviest
live price strings, EVERY line discounted, and every line a DIFFERENT per-unit
saving so no two discount rows can share an entry.

| lines | instructions | headroom |
| --- | --- | --- |
| 75 | 9.74M | 11.5% |
| **80** | **10.37M** | **5.7%** |
| 85 | 11.00M | none |
| 90 | 11.63M | over |

80 is the end of this architecture as it stands. Per-line cost is ~0.125M and is
structural, so 11M / 0.125M puts the arithmetic ceiling near 88 lines at zero
margin. Real carts are cheaper than this bound (#1986's real 82 lines measure
10.62M and would fit) but the guard cannot be set on the average case, because
going over bills the buyer FULL RETAIL.

Coverage: 378 of the 380 B2B orders placed since 1 June 2026 are 80 lines or
fewer (99.5%). At the old guard of 45 it was 362 (95.3%). The two that still miss
out are #1986 (82 lines) and #1397 (104).

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
