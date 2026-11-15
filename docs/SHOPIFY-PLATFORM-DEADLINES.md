# Shopify platform deadlines for this app

Last reviewed 16 Nov 2026 against the Shopify developer changelog (entries from
25 Sept 2026; earlier ones were not readable that day).

## Where things stand

| Item | State on 16 Nov 2026 | Next date |
| --- | --- | --- |
| Admin API version, main client (`app/shopify.server.js`) | **2026-04** since 16 Nov 2026 | retires 16 Apr 2027 |
| Admin API version, raw fetches and scripts | 2026-04 and 2026-07 | 16 Apr 2027 / 16 Jul 2027 |
| Webhooks (`shopify.app.toml`) | 2026-04 | 16 Apr 2027 |
| Pricing Functions (`extensions/*/shopify.extension.toml`) | 2026-04 | 16 Apr 2027 |
| `checkout-price-display` extension | api_version **2026-01**, code still on the 2025.7 React library | **16 Jan 2027** |
| Expiring offline access tokens | on | done (deadline was 1 Jan 2027) |
| IP allowlist | **not checked**, see below | 20 Nov 2026 / 1 Jan 2027 / 1 Apr 2027 |
| `b2b-custom-prices` uses the deprecated Product Discount API | works | no removal date published |

## Admin API version

Until 16 Nov 2026 the main client pinned `ApiVersion.October25` (2025-10).
Shopify retired that on 16 Oct 2026 and had been answering as 2026-01 ever
since, without any error. It is now `ApiVersion.April26`.

**Before changing it again, run the validator.** It checks every Admin GraphQL
document in `app/` against the live schema of the versions you name:

```
node scripts/validate-admin-graphql.mjs 2026-04 2026-10
```

On 16 Nov 2026: 2026-04 gave 105 valid, 0 invalid (6 more build their text at
run time and cannot be parsed; they use long-standing fields).

**2026-10 is NOT a drop-in.** It rejects `collectionCreate(input:)` and
`collectionUpdate(input:)`, used in `app/routes/app.bogo.jsx` (three places) and
`app/lib/brand-order.server.js`. Those need rewriting first. The installed
`@shopify/shopify-api` (12.3.0) also has no constant newer than `April26`, so
the package needs upgrading for 2026-10.

**Found by the validator and fixed the same day:** `cartTransformCreate` no
longer takes `functionId` in any version still served. The pricing monitor's
repair of a missing cart transform (`app/lib/pricing-health.server.js`) and the
Activate Transformer page both used it, so the repair would have failed on the
day it was needed. Both now pass `functionHandle: "b2b-price-transformer"`.

Deprecated but still working fields in use (no date yet): `Customer.email`,
`Customer.phone`, `Customer.emailMarketingConsent`, `collectionByHandle`,
`ProductVariant.image`, `Product.featuredImage`, `collectionAddProducts`,
`collectionRemoveProducts`.

## Checkout price display extension

`shopify app deploy` refuses any app version in which an extension declares a
retired API version, and one app version carries every extension. That blocked
the pricing release on 16 Nov 2026 until this extension went from 2025-10 to
2026-01 (config only, as on 9 Oct for 2025-07). It will block every deploy again
after **16 Jan 2027**. From 2027-01 its metafield declarations also need
`owner_type`. It needs a proper update to the current Checkout UI library before
then, checked in a real checkout.

## IP allowlist

Shopify's rule (developer docs, read 16 Nov 2026):

- Public apps: required. 20 Nov 2026 delisted and no new installs; 15 Jan 2027
  merchants see a warning; **1 Apr 2027 Admin API requests are rejected.**
- Custom apps installed on a store outside the app's organisation: required to
  install from 20 Nov 2026, and for existing installs from 1 Jan 2027.
- Apps only on stores in their own organisation: recommended, not required.

An existing install keeps working past 20 Nov 2026 in every case, so orders are
not at risk on that date.

**Not checked:** whether this app has an allowlist, or which of the three cases
it is. The app sits in the Dev Dashboard organisation "Tripster Developers"
(org 128964217); the browser login available on 16 Nov was a different
organisation and got 403. Someone with that login needs to open the app's
settings there.

**Before switching an allowlist on,** list every place that calls the Admin API
with this app's token, because anything not listed gets a 403:

- the Render service (its outbound IP ranges, from the Render dashboard)
- this office PC: `scripts/*.mjs`, the deal-sheet scripts and ad-hoc checks all
  use the app's stored token directly
- any scheduled job that runs somewhere else

Turning it on with only Render listed would break the local scripts, including
the month-end deal sheet run.
