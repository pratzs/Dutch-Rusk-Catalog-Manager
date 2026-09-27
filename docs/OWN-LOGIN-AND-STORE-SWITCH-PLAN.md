# Own login and no-code store switching: plan

Status: **plan only, not built, not live.** Written 28 Sept 2026 after the
store switcher was removed (see `docs/SHARED-CART-AND-STORE-SWITCHER.md`).
Nothing here changes any customer's login until Pratham approves it.

## What Pratham asked for

Customers can sign in with a **password or an emailed code**, and owners with
several stores can **switch between them quickly**, without logging in again
each time.

## The constraints

- **Each store is its own Shopify customer** with its own login email. Staff
  share that email. **Ostendo maps orders to the store by Shopify customer
  ID**, so this must never change: no login may cover more than one store.
- Shopify's own sign-in sends a code on every login and holds one login per
  browser. That is why the removed switcher always meant a logout and a code.

## How it would work

Shopify Plus lets a store use its **own identity provider** (OpenID Connect)
instead of Shopify's sign-in. The Catalog Manager app already contains one,
built on 2 July 2026 and never switched on (routes `app/routes/oidc.*`,
`[.]well-known.openid-configuration.jsx`, `app/lib/oidc.server.js`,
`app/lib/b2b-auth.server.js`, Prisma models `B2BUser`, `B2BOtpCode` and others).

1. **Signing in.** Our page offers the store's password or a code by email.
   Shopify then signs the browser in as the Shopify customer named in our
   token (`sub` = that store's customer ID, `email` = that store's email). So
   store B's login always lands in store B's customer, and Ostendo is safe.
2. **Remembering stores on a device.** After a store is verified once on a
   device (password or code), our login remembers that on that device for a
   set time, in a secure cookie on our own domain.
3. **Switching.** A new switcher in the theme sends the owner to Shopify's
   single sign-on address,
   `/customer_authentication/login?login_hint=<store email>&return_to=<page>`.
   Shopify asks our login silently (`prompt=none`). If this device has already
   verified that store, it signs straight in: **no code, no password**. If not,
   our sign-in page opens for that one store, once.
4. Each store keeps its own cart (the shared cart already handles a change of
   login on one device), prices, catalogue, rep emails and orders.

## What exists and what is missing

The code review on 28 Sept found it roughly 80% built.

**Already there:** discovery, authorize, token (code and refresh), signing
keys; a sign-in page with password or emailed code (Brevo); invite, reset and
set-password pages; an admin list with invite, reset, disable; a CSV importer.

**Missing or wrong for this plan:**
- **Built for the wrong customer layout.** It assumes one email is one Shopify
  customer with several stores. It must become one login per store, matching
  the real Shopify customers, loaded from Shopify's company contacts rather
  than the old Django export.
- **No session on our side**, so no silent sign-in: `prompt=none` and
  `login_hint` for single sign-on are not handled. No remembered stores per
  device. No userinfo or logout endpoints (discovery advertises userinfo).
- **Security fixes needed before any customer uses it:**
  - it would redirect to any address it is given (needs an allowlist)
  - it reveals store names and usernames for any email typed in
  - code and reset emails can be triggered without limit
  - a sign-in code or refresh token could be used twice at the same moment
  - disabled logins can still finish signing in
- The old store pre-select route never runs (wrong route name) and relies on
  an undocumented Shopify address. Not needed in this plan.
- Import bugs: re-importing demotes active users; browser-sent ids are saved
  unchecked.

## Risks

- **Every customer's sign-in changes at once.** Shopify connects an identity
  provider for the whole store, not per customer.
- **Our app becomes the front door.** If the app or Brevo is down, nobody can
  sign in. Today Shopify carries that.
- **Emailed codes come from Brevo** instead of Shopify, so deliverability must
  be proven first (Brevo is already used for rep emails and campaigns).
- **Rollback:** switching the identity provider off in Shopify admin returns
  everyone to Shopify's sign-in. To be confirmed on the test store, including
  what happens to customers who are signed in at that moment.

## Proposed steps

1. Confirm on a Shopify Plus development store with B2B: silent sign-in
   (`prompt=none`) after logout, the rollback switch, and that the order
   lands on the right customer.
2. Rebuild the data model to one login per store from Shopify company
   contacts; fix the security issues; add the device session, `prompt=none`,
   userinfo and a safe logout.
3. Build the new switcher on single sign-on. Test with the simulator and by
   real clicks, as for the shared cart.
4. Pilot with Worthy Oceania test logins on the live store only after the
   development store passes, then Pratham decides on switching it on for
   everyone and on the customer message.

Estimated build: several days, plus testing on the development store.
