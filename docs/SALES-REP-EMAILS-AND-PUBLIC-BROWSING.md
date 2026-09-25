# Sales rep order emails and public browsing

Both went live on 25 Sept 2026. This page is the reference for how they work,
where the moving parts live, and the traps. The dated history is in the Launch
Folder CHANGELOG; current state and open items are in HANDOFF.

## 1. Sales rep order emails

When a customer orders on the website, their sales rep gets an email.

### How it works

1. `app/routes/webhooks.orders.create.jsx` runs on every `orders/create`.
2. It reads the customer metafield `custom.sales_reps` (single line text). Ray
   pushes this from Ostendo; it was first populated on 20 and 21 Sept 2026.
3. It looks the code up in the `SalesRep` table (Prisma, `shop` + `repCode`),
   managed in the app at **Sales Reps**. No row, or an inactive row, means no
   email and a warning in the logs.
4. `sendSalesRepOrderNotification` in `app/lib/brevo.server.js` sends through
   Brevo (tag `dr_sales_rep_order`, subject `New order #1234, Company`).
5. The order is stamped with the custom attribute `Sales Rep Notified: <email>`,
   which also stops a webhook retry emailing twice.

The email shows the PO number (`po_number`) and order note (`note`), always,
as "Not given" or "None" when empty. Prices come from
`app/lib/rep-line-items.server.js`.

### Rep list (25 Sept 2026)

| Code | Rep | Email |
| --- | --- | --- |
| 410 | Jerry | jerry@dutchrusk.nz |
| 420 | Michelle | michelle@dutchrusk.nz |
| 430 | Keith | keith@dutchrusk.nz |
| 450 | Christchurch office | admin@dutchrusk.nz |
| 460 | Chris | chris@dutchrusk.nz |
| 461 | Ravi | ravi@dutchrusk.nz |
| 470 | Lynette | lynette@dutchrusk.nz |
| 490 | Leith | leith@dutchrusk.nz |

440, 463 and 480 are deliberately unassigned (no row, no email).
`dutchrusk.nz` is a different domain from `dutchrusk.co.nz`; both have valid
Microsoft 365 mail.

### Traps

- **A rep code on a customer is not enough.** A new code from Ostendo sends
  nothing until it has a row on the Sales Reps page.
- **`li.price` is retail on this shop.** The cart transform raises B2B lines to
  retail and the wholesale discount pulls them back, so the paid price is
  `li.price` minus the line's `discount_allocations`. Using `li.price` as "the
  price" is what put retail in the email with no strikethrough.
- **Most pack-size variants have no image.** Fall back to
  `product.featuredImage`, or every line shows the logo.
- **Nothing earlier in the webhook may `return` from the handler.** The
  discount-notes step used to return a Response when an order had no saving,
  which is every order now, and silently skipped the rep email. It runs in its
  own function so bailing out ends only that step.

## 2. Public browsing with prices for wholesale accounts only

Anyone can browse b2b.dutchrusk.co.nz. Prices, ordering and the cart are only
for logged-in customers with a company.

### The three layers

1. **Store access switch** (Online Store > Preferences > "Restrict access to B2B
   customers only") is **off**. With it on, guests get a bare 401 and none of
   the rest matters.
2. **Theme** (Worthy-Technology/WorthyProductsSouthWebsite). Everything is gated
   on `customer.b2b?`, so company customers render exactly what they did before.
   - `snippets/price.liquid`, `snippets/buy-buttons.liquid` and the product
     title and sticky prices in `sections/main-product.liquid` render
     `snippets/drusk-guest-cta.liquid` for everyone else.
   - `layout/theme.liquid`: body class `drusk-guest`, a CSS safety net that hides
     anything price or cart shaped (including the PushOwl widget), the redirect
     for a login with no company, the `/cart` redirect for guests, and a click
     handler that sets the log-in return path.
   - `sections/announcement-bar.liquid`: slides containing `$` are skipped for
     guests.
   - `/pages/wholesale-account` uses `templates/page.wholesale-account.json` and
     `sections/main-wholesale-account.liquid`; the two PDFs are theme assets.
3. **Checkout rule "Wholesale accounts only"** (`extensions/b2b-company-required`,
   a cart and checkout validation Function, switched on in Settings > Checkout >
   Checkout rules, fail-open). It blocks only when all of these hold: the buyer
   is at a checkout step (never a cart interaction), it is not a POS sale, there
   is no purchasing company, and the customer is not tagged
   `wholesale-checkout-exempt`.

### Evidence it does not touch current customers

- Online orders 25 Jun to 25 Sep 2026: 556 of 556 had a company.
- POS orders in the same window: 286, none with a company, hence the POS
  exclusion.
- The theme's deals menu has relied on `customer.b2b?` since 10 Sept (25 deal
  orders from 23 companies went through it).

### Traps

- **If the store access switch is off, the checkout rule must be on.** The
  theme hides things, it cannot stop the cart URLs being called directly.
- **Log in links must use `routes.storefront_login_url`,** or a customer with no
  company lands on Shopify's account pages and the redirect never fires.
- **Background-fetched cards** (related products, predictive search) get the
  fetch URL as `request.path`, so `storefront_login_url` would return the buyer
  to a raw HTML fragment. The snippet falls back to the Shop page and the click
  handler sets the real page.
- **The product card link covers the card** (`a.full-unstyled-link::after`,
  z-index 1). Anything clickable inside a card needs `position: relative` and a
  higher z-index.
- **Retail prices stay readable** in Shopify's product JSON (`/products/*.js`).
  Wholesale prices never are. Accepted on 25 Sept.
- **Test with real clicks.** Reading an href is not a test; the card link bug
  had a correct href.

### Deploying

- Theme: push `main` in the theme repo, live in about a minute.
- App server: push `main` here, Render deploys.
- Functions: `shopify app deploy --allow-updates --message "..."` (CLI 4.8
  removed `--force`).
