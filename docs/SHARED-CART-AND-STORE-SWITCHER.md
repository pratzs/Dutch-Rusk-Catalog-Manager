# Shared cart and store switcher

Built 25 and 26 Sept 2026 from two pieces of customer feedback. **The shared
cart is live for every company customer since 26 Sept 2026. The store switcher
was removed on 28 Sept 2026** (section 2 says why and what replaces it).

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
7. Each device remembers whose cart it holds (localStorage `drusk_sc_owner`).
   Shopify leaves the cart in the browser after logout, so when a different
   login or store signs in on that device, the browser cart belongs to
   someone else: the device takes the new login's own saved cart and never
   merges the leftover lines in (found 28 Sept: store A's items would have
   landed in store B's cart, and on B's other devices).

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
  carts are combined (nothing is thrown away). This only applies to a device
  with no previous login recorded; a device that last held another login's
  cart takes the new login's saved cart instead.
- Logged-out visitors do not see the "You have ... in cart" badges (guest
  safety net in `layout/theme.liquid`), even though Shopify keeps the
  previous login's cart in the browser.
- `SharedCart.locationGid` holds the cart key
  `gid://shopify/CompanyLocation/<id>|customer/<id>`, not a bare location.

## 2. Store switcher (removed 28 Sept 2026)

Live 26 to 28 Sept, then removed at Pratham's request after live testing.

**Why it could not work well:** each store is its own Shopify customer with its
own login email, shared by that store's staff, and Ostendo maps orders to the
store by Shopify customer ID. So stores must stay separate customers. Shopify
holds one login per browser and sends a code on every sign in, so moving to
another store's login always meant logging out and entering a code. Two
logins for the same store also looked identical in the list. Customers found
it confusing.

**Ruled out:** giving one login access to several stores (Shopify's own store
picker, `url_to_set_as_current`). No code needed, but the orders would land
on the wrong customer for Ostendo, and a store login shared by staff would
give those staff access to the other stores.

**What was removed:** `snippets/drusk-store-switcher.liquid` and its two
renders in `layout/theme.liquid`, and the "Switch store" links in
`snippets/header-drawer.liquid` and `sections/announcement-bar.liquid`
(theme commit 8b1a762). Old localStorage keys `drusk_accounts` and
`drusk_switch` may remain on devices; nothing reads them.

**What can replace it:** our own sign-in (the parked OIDC login in this app)
with Shopify single sign-on. See `docs/OWN-LOGIN-AND-STORE-SWITCH-PLAN.md`.
