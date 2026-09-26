# Shared cart and store switcher

Built 25 and 26 Sept 2026 from two pieces of customer feedback. **Both are live
for every company customer since 26 Sept 2026.**

1. A staff member and their manager use the **same login** on different
   devices and want to see the same cart ("add it, then ask the manager to
   refresh").
2. Owners with **several stores, each with its own login**, want to switch
   between them quickly. Logins must stay separate; nothing is merged.

This page is the reference for how both work, where the parts live, and the
traps. Dated history is in the Launch Folder CHANGELOG; current state and open
items are in HANDOFF.

## 1. Shared cart

### What the customer sees

- Add, change or remove something on one device and every other device on the
  same login shows it within a few seconds, with no refresh. A small "Cart
  updated from another device" note appears.
- On the cart page itself the page reloads to show the new cart, but never
  while someone is typing a quantity.
- After an order is placed on one device, the other devices' carts empty, so
  nothing can be ordered twice.
- Nothing else changes. Prices, checkout, catalogues and discounts are all
  Shopify's own.

### Who gets it

| Setting | Where | Effect |
| --- | --- | --- |
| `custom.shared_cart_mode = "all"` | Shop metafield | On for every company customer |
| `custom.shared_cart_enabled = true` | Company location metafield | On for that store only (the pilot switch) |

Guests and non-company logins never receive the script. Setting the shop
metafield to anything other than `all` (or deleting it) turns it off for
everyone within a minute; the browser carts simply carry on as normal Shopify
carts.

**One cart per login per store.** Two different logins at the same store (for
example a bar and a kitchen ordering separately) keep separate carts.

### How it works

Shopify keeps the online store cart in the browser, not the account, so each
device has its own cart. We keep one copy per login and store in our database
and each browser syncs with it.

| Part | File |
| --- | --- |
| Theme script (only rendered when switched on) | `snippets/drusk-shared-cart.liquid` in the theme repo, rendered from `layout/theme.liquid` |
| Proxy endpoint `/apps/dr-account/shared-cart` | `app/routes/shared-cart.jsx` |
| Live stream (Server-Sent Events) | `app/routes/shared-cart-stream.jsx`, `app/lib/shared-cart-events.server.js` |
| Storage, merge rules, switches | `app/lib/shared-cart.server.js`, Prisma model `SharedCart` |
| Empty after an order | end of `app/routes/webhooks.orders.create.jsx` |

1. The theme notices cart changes from the requests the theme already makes
   (a PerformanceObserver on `/cart/add|change|update|clear`). It never edits
   the theme's own cart code.
2. It saves the cart with the version it last agreed with. The save is one
   conditional `UPDATE ... WHERE version = n`, so two devices saving at once
   cannot overwrite each other; the loser gets a 409 and merges.
3. The merge is three-way against the last agreed cart. A change on one side
   wins, including a removal. If both changed the same line, the larger
   quantity wins. Quantities are never added together, so nothing doubles.
4. An emptied cart (almost always an order) wins over a change elsewhere, so
   ordered items cannot come back.
5. Every save is pushed straight away to the other open devices over the live
   stream, carrying the new cart. The device applies it with one
   `cart/update.js` that sets exact quantities, and the same reply returns the
   new header cart icon.
6. A check every 4 seconds (every 16 while the stream is connected) is the
   safety net. A device that could not finish a sync (server restart, outage)
   retries on each check until it does. Every 16 seconds an open page also
   compares its own cart with the last agreed one, so a change it never saw
   a request for still gets saved (found live on 26 Sept: a cart clear the
   observer missed sat unsynced until the next cart action).

The stream token is signed with the app secret, lasts 12 hours, and names one
shop and one cart. It is only issued through the app proxy, where Shopify has
already verified the customer.

### Emptying after an order

`orders/create` empties the customer's shared cart for that store only when:
the order came from the online store (`source_name = web`, never a rep's draft
order), and nobody edited the cart after the order was placed (so a next order
already started is kept).

### How it was proven (26 Sept 2026)

- Unit tests: `app/lib/__tests__/shared-cart.test.js` and
  `shared-cart-events.test.js`, 39 passing (`npx vitest run app`).
- Real database: 50 of 50 concurrent saves kept, 104 conflicts caught and
  merged, no lost or doubled lines.
- Simulator (5 devices, random actions, random delays): 12 named scenarios
  (refresh, no refresh, five devices adding at once, simultaneous edits of one
  line, checkout during an edit, sold-out lines, idle pages) plus random
  stress, all passing. Outage tests: server errors, network failure and an
  HTML error page during edits on two devices, then recovery with nobody
  touching anything; the store copy being reset; and changes the page never
  saw a request for. The version live on the morning of 26 Sept failed the
  outage, reset and unnoticed-change tests; the current one passes all 22.
- Live store: changes from another device reached an open page and updated
  the header icon in place with no navigation; a stale save was refused with
  409; 100 simultaneous requests to the endpoint all answered, slowest 2.1 s.
- The script on the live page was checked byte for byte (SHA-256) against the
  tested script.

### Speed

About 3 to 4 seconds from a tap on one device to the other device's header.
Most of that is Shopify's own cart update (about 2.5 s on this store because
of the wholesale pricing rules), which also applies to a normal Add to Cart.
The app runs in Singapore and its database in Oregon; moving the database
next to the app would save a few hundred milliseconds per save.

### Traps

- The app runs as a single Render instance and keeps stream connections in
  memory. If it is ever scaled to more than one instance, the stream needs a
  shared channel (Postgres LISTEN/NOTIFY); the 4-second checks keep working
  meanwhile.
- The first time two devices that already had different carts join, their
  carts are combined (nothing is thrown away).
- `SharedCart.locationGid` holds the cart key
  `gid://shopify/CompanyLocation/<id>|customer/<id>`, not a bare location.

## 2. Store switcher

`snippets/drusk-store-switcher.liquid` in the theme repo, plus a "Log in to
another store" link in `snippets/header-drawer.liquid` (phone menu, under
Account) and `sections/announcement-bar.liquid` (desktop top bar, next to
Account).

### What the customer sees

1. **First time:** "Log in to another store" in the menu or top bar. It logs
   out, opens sign in, and returns to the same page after the emailed code.
2. **After that:** a small "Store: <name>" button at the bottom right of every
   page. Tap it, pick the store (its email is filled in), enter the code.
3. The x next to a store forgets it on that device.

Each store keeps its own login, prices, cart and orders. Nothing is merged.

### How it works

- Remembers, on this device only, each company store login used here (email
  and store name in localStorage `drusk_accounts`, never a password, at most
  10).
- A login with no company (sent to /pages/wholesale-account) is never
  remembered as a store. It still gets the button, labelled "Signed in:", when
  the device remembers a store, so someone who switched to an account that is
  not set up can switch back.
- A switch writes `drusk_switch` (email, return page, time) then logs out.
  The head part of the snippet sees it on the next guest page and sends them
  to `/customer_authentication/login?return_to=...&login_hint=<email>`. A
  switch older than 3 minutes is ignored.
- Without JavaScript the menu link is a plain log out link.
- Bottom right because the PushOwl bell and its pop-ups use the bottom left.

### The code on every switch

Shopify sends a code on every sign in to its own login and there is no
setting to skip it. The only way to switch without a code is to move the
whole store's login to our own identity provider (the OIDC login designed in
July 2026 and built into this app, never switched on). That changes every
customer's login at once and makes our app a single point of failure for
sign in, so it is a separate project, not a tweak.

### How it was proven (26 Sept 2026)

- 20 logic checks (first and second store, same email in different case,
  a login with no company, 10-store cap, the menu link with one store
  remembered, corrupted saved data, the step after logout, abandoned switches).
- Live: switched from Worthy Oceania to a login with no company and back with
  one tap each, email filled in both times; the button showed on the setup
  page; the menu and top bar links checked on phone and desktop; guests see
  none of it. A full switch between two company stores was not run, because
  no second company login was available for testing.
