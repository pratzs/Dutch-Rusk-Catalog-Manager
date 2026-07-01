# Dutch Rusk B2B Custom Auth — Phase 1 Design

**Status:** Draft for review
**Author:** Pratham (with AI-assisted architecture review)
**Last updated:** 2026-07-02

---

## Problem

Dutch Rusk is migrating ~625 (actually **767 usable, 775 total**) wholesale customers from a Django site to Shopify Plus B2B. On Django they used **Username + Password**. In Dutch Rusk's B2B model, a single owner can operate **up to 10 physical stores under one email address** (confirmed in the CSV: `admin@corsainternational.co.nz` has 10 usernames, one per store). Shopify's native B2B login relies on **Email + OTP**, which:

1. Sends every OTP to the same inbox regardless of which store the customer wants to shop for.
2. Forces the customer through a "which company do you want to shop as?" picker on every session where they have >1 CompanyContact.
3. Doesn't preserve the Django username at all — customers would have to relearn login.

We need to keep username-based login while running on Shopify B2B.

## Constraint that shaped the architecture

**Multipass ≠ B2B.** Verified against `shopify.dev`:

> "Multipass login is only available with **legacy** Customer accounts."
> "B2B only works with **new** customer accounts."

So the Multipass HMAC-token pattern used in Worthy Products (`pratzs/odoo-connector` → `services/multipass.py`) does **not transfer** — legacy accounts and B2B are mutually exclusive on the same store.

Shopify's official replacement, quoted verbatim from their docs:

> "If you're currently using Multipass or the Storefront API token flow with classic customer accounts, Shopify recommends migrating to a **third-party identity provider**."

## Architecture

The **Catalog Manager app** hosts an **OpenID Connect Identity Provider (OIDC IdP)**. In Shopify admin → Settings → Customer accounts → Third-party identity provider, we register our app's discovery URL, Client ID, and Client Secret. From then on, Shopify delegates all customer login to us.

```
┌────────────────────────────┐        1. Click "Log in"           ┌──────────────────┐
│ dutchrusk.co.nz storefront │ ─────────────────────────────────► │ Shopify Accounts │
└────────────────────────────┘                                    └────────┬─────────┘
              ▲                                                             │ 2. Delegate to IdP
              │                                                             ▼
              │                                              ┌─────────────────────────────┐
              │        6. Redirect w/ session                │ Catalog Manager OIDC IdP    │
              │◄─────────────────────────────────────────────┤  (/oidc/authorize)          │
              │                                              └─────────────┬───────────────┘
              │                                                             │ 3. Show login page
              │                                                             ▼
              │                                              ┌─────────────────────────────┐
              │                                              │ /oidc/login                 │
              │                                              │ [Username+Password] [OTP]   │
              │                                              └─────────────┬───────────────┘
              │                                                             │ 4. Verify bcrypt hash
              │                                                             ▼
              │                                              ┌─────────────────────────────┐
              │        5. ID token (RS256)                   │ /oidc/token                 │
              │◄─────────────────────────────────────────────┤   iss, aud, sub, email,     │
              │            (via Shopify)                     │   urn:shopify:...           │
              │                                              └─────────────────────────────┘
```

**Zero-touch commitment:** Nothing existing changes. All new code lives under:

- `app/routes/oidc.*.jsx` — public OIDC endpoints
- `app/routes/app.customers.*.jsx` — admin UI (embedded, Polaris)
- `app/lib/oidc.server.js`, `app/lib/brevo.server.js`, `app/lib/csv-importer.server.js`
- `prisma/schema.prisma` — new models appended
- `extensions/catalog-variant-hider/blocks/pre-select-location.liquid` — one small storefront snippet (or a new sibling extension)

Existing routes (`app.catalog-manager.jsx`, `app.catalog-rules.jsx`, `app.catalog-overrides.jsx`, `webhooks.companies_sync.jsx`) are untouched.

## Data model (Prisma additions)

```prisma
model B2BUser {
  id                  String   @id @default(cuid())
  shop                String
  username            String              // Django username, verbatim
  passwordHash        String?             // bcrypt; null until invite completed
  email               String              // may be shared across siblings
  customerGid         String              // gid://shopify/Customer/...
  companyContactGid   String
  companyGid          String
  companyLocationGid  String              // used for storefront pre-select
  storeDisplayName    String              // "Dutch Rusk Ponsonby" — in emails
  catalogGroup        String              // "General" | "Night n Day" | "TEEG" | ...
  status              String   @default("invited")  // invited | active | disabled
  lastLoginAt         DateTime?
  invitedAt           DateTime?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([shop, username])
  @@index([shop, email])
  @@index([shop, catalogGroup])
  @@index([customerGid])
}

model B2BPasswordResetToken {
  id         String   @id @default(cuid())
  userId     String
  tokenHash  String   @unique             // sha256(token) — token itself never stored
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime @default(now())
  purpose    String   @default("reset")   // reset | invite
  @@index([userId])
}

model B2BLoginAudit {
  id         String   @id @default(cuid())
  shop       String
  username   String?
  email      String?
  result     String                       // ok | bad_password | unknown_user | disabled | oidc_error | otp_sent | otp_verified | otp_bad
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())
  @@index([shop, createdAt])
  @@index([username])
}

model OidcSigningKey {
  id               String   @id @default(cuid())
  kid              String   @unique       // key id exposed via jwks
  algorithm        String   @default("RS256")
  publicJwk        Json                   // served at /oidc/jwks.json
  privateKeyEnc    String                 // PEM, encrypted at rest using APP_SECRET
  activeForSigning Boolean  @default(true)
  createdAt        DateTime @default(now())
  rotatedAt        DateTime?
}

model OidcAuthCode {
  id                String   @id @default(cuid())
  code              String   @unique      // opaque, 32 bytes urlsafe
  b2bUserId         String
  companyLocationGid String
  clientId          String                // Shopify's client id for the shop
  redirectUri       String
  nonce             String?
  scope             String
  codeChallenge     String?               // PKCE if Shopify sends one
  codeChallengeMethod String?
  createdAt         DateTime @default(now())
  expiresAt         DateTime              // 5 min from creation
  consumedAt        DateTime?
  @@index([expiresAt])
}
```

## OIDC ID token — claim shape

```json
{
  "iss": "https://dutch-rusk-catalog-manager.onrender.com",
  "aud": "<shopify-client-id-registered-in-admin>",
  "sub": "gid://shopify/Customer/6123456789",
  "email": "admin@corsainternational.co.nz",
  "email_verified": true,
  "iat": 1751123456,
  "exp": 1751127056,
  "nonce": "<from-authorize-request>",
  "urn:shopify:customer:tags": ["b2b-general", "corsa-group"],
  "urn:dutchrusk:location_gid": "gid://shopify/CompanyLocation/987",
  "urn:dutchrusk:username": "2cheap.pakuranga"
}
```

- **`sub` is stable per Shopify Customer** — one email = one Customer even when they own 10 stores. The username is carried in a custom claim for our own auditing, not for Shopify's identity resolution.
- **`email_verified: true`** — we set this because Ostendo has vetted the emails.
- Custom `urn:dutchrusk:location_gid` is picked up by our storefront snippet (not Shopify) to pre-select the location.

## Login flow (in detail)

1. Customer clicks "Log in" on `dutchrusk.co.nz`.
2. Shopify redirects to our `/oidc/authorize?client_id=<shopify>&redirect_uri=<callback>&response_type=code&scope=openid+email+profile&state=...&nonce=...`.
3. We render `/oidc/login` with two tabs:
   - **Username + Password** (default)
   - **Email + OTP** (toggle)
4. **Password path:**
   - Submit → look up `B2BUser` by `(shop, username)`.
   - Verify `bcryptjs.compare(password, user.passwordHash)`.
   - Require `status = "active"`.
   - Generate `OidcAuthCode`, redirect to `redirectUri?code=<code>&state=<state>`.
   - Shopify calls `/oidc/token` with the code → we return `id_token` + `access_token` (opaque).
5. **OTP path:**
   - Submit email → we look up all `B2BUser` rows with that email.
   - If exactly one → generate 6-digit code, hash+store, send via Brevo `dr_login_otp`.
   - If many (e.g. `admin@corsainternational.co.nz` → 10 usernames) → show "Which store?" picker first, then send OTP for the chosen one.
   - User enters code → same `OidcAuthCode` issuance as (4).
6. Every attempt (success or failure) writes a `B2BLoginAudit` row.
7. Storefront pre-select hook picks up the `companyLocationGid` from the signed cookie we set alongside the OIDC redirect (see below).

## Storefront pre-select hook (skips B2B company picker)

**Problem:** Even with a successful OIDC login as `sub = customerGid`, Shopify's B2B storefront normally shows a "which company do you want to shop as?" screen on first login (and any time the session doesn't have a location bound). For a customer with 10 stores, this is exactly the confusion we're trying to eliminate.

**Solution:**

1. On successful OIDC auth, our `/oidc/token` handler (before redirecting Shopify's callback) sets an HttpOnly cookie on `.dutchrusk.co.nz`:

   ```
   Set-Cookie: dr_target_location=<hmac-signed { companyLocationGid, exp: now+120s }>;
               Domain=.dutchrusk.co.nz; Path=/; Secure; HttpOnly; SameSite=Lax
   ```

2. A small theme app extension block (`pre-select-location.liquid`) runs on the storefront layout when `{% if customer %}`. It POSTs the signed cookie value to `/apps/dr-account/select-location`.

3. That endpoint (in our app) verifies the HMAC, then calls Customer Account API to set the current buyer's `companyLocationId` for the session.

4. Cookie is deleted after use. Fails silent — if anything breaks, customer just sees Shopify's normal picker.

This is not a Shopify-supported claim (`urn:dutchrusk:location_gid` is informational, not acted on by Shopify) — it's a companion mechanism riding on the app-proxied storefront.

## CSV import flow (Phase 1 rollout)

**Input:** `User-2026-07-01.csv` (775 rows).

**Steps:**

1. Admin uploads via `/app/customers/import`.
2. Parser skips rows where `customer_id` is blank (8 rows). Result: **767 rows** to process.
3. For each row, we resolve to Shopify GIDs:
   - **Query 1:** `customers(query: "email:'{email}'")` → get `Customer` (may return one with N companyContacts).
   - **Query 2:** For that Customer, list its CompanyContacts + Locations. Find the one where `CompanyLocation.name` matches CSV `first_name` (case-insensitive, trimmed).
   - If exactly one match → resolved.
   - If zero or many matches → row goes to **resolution report**.
4. Preview screen: matched / unmatched / ambiguous counts + downloadable CSV of unmatched rows.
5. Admin confirms → we insert `B2BUser` rows in bulk transaction with `status = "invited"`, `passwordHash = null`.
6. Post-import, admin lands on `/app/customers` with the Polaris **Tabs** view — one tab per `catalogGroup`:
   - **All** (767)
   - **General** (617)
   - **Night n Day** (67)
   - **TEEG** (35)
   - **Hampshire Vending** (12)
   - **Distributors 30** (7)
   - **Food & Beverage TEEG** (5)
   - **Archie Brothers** (3)
   - **Service Foods Marlborough** (2)
   - **TEEG Street Sites**, **Xtreme Wairau**, **Kingpin Queenstown**, **Asia Link**, **Holey Moley**, **Mediterranean Foods Nelson**, **DKSH**, **Boyd & Major** (1 each)
7. Each tab has bulk-select + actions: `Send invite`, `Resend`, `Force reset`, `Disable`.

## Invite email (Brevo template `dr_b2b_invite`)

**Vars:** `first_name`, `store_display_name`, `username`, `action_url`, `expires_in_days`

```
Subject: Set up your Dutch Rusk B2B account — {{ store_display_name }}

Hi {{ first_name }},

Your Dutch Rusk B2B wholesale account is ready for {{ store_display_name }}.

  Username: {{ username }}
  Store:    {{ store_display_name }}

Please save your username — you'll need it every time you log in.

Set your password:
{{ action_url }}

This link expires in {{ expires_in_days }} days. If it expires, return to
the login page and use "Forgot password" to get a new one.

Note: if you manage multiple Dutch Rusk stores, you'll receive a separate
email for each — each with its own username. Your email address stays the
same across all of them.

Dutch Rusk Team
```

## Password reset email (Brevo template `dr_b2b_reset`)

The store name + username disclosure is **explicitly required** because the same inbox can receive up to 10 reset emails from the same person:

```
Subject: Reset your password — {{ store_display_name }} ({{ username }})

Hi {{ first_name }},

Someone requested a password reset for:
  Store:    Dutch Rusk {{ store_display_name }}
  Username: {{ username }}

If this was you, click here to set a new password:
{{ action_url }}

This link expires in {{ expires_in_hours }} hours.

If you did not request this, you can ignore this email. The password for
this account will not change. If you manage other Dutch Rusk stores under
the same email address, those accounts are NOT affected by this request.

Dutch Rusk Team
```

## OTP email (Brevo template `dr_login_otp`)

```
Subject: Your Dutch Rusk login code — {{ code }}

Hi {{ first_name }},

Your login code for {{ store_display_name }} ({{ username }}) is:

    {{ code }}

This code expires in {{ expires_in_min }} minutes.

If you didn't request this, you can ignore this email.

Dutch Rusk Team
```

## Rollout plan

**Milestone 1 — infra + doc review (this doc)**
- Prisma migration added (not applied to prod DB).
- OIDC endpoints stubbed, returning valid discovery + jwks.
- Test with 1 dummy B2BUser, log in end-to-end from Shopify → Catalog Manager → back to storefront.

**Milestone 2 — importer + admin UI**
- `/app/customers` with Tabs + ResourceList.
- CSV importer with resolution report.
- Import all 767 rows into a **staging table** (or dry-run flag) — do NOT send invites yet.

**Milestone 3 — Brevo + bulk invite**
- Brevo templates published, sender verified.
- Bulk invite sends to a **test group of 5 customers** first (Dutch Rusk internal staff accounts).
- Verify emails render, links work, password can be set, login succeeds.

**Milestone 4 — go-live**
- Enable third-party IdP in Shopify admin.
- Send invites in batches of 50 with rate-limit backoff.
- Monitor `B2BLoginAudit` daily for the first two weeks.

## Security & operational notes

- **Secrets:** `OIDC_CLIENT_SECRET` (shared with Shopify), `APP_SECRET` (encrypts `OidcSigningKey.privateKeyEnc` + signs storefront cookies), `BREVO_API_KEY`. All via env vars on Render, never committed.
- **Password policy:** minimum 8 chars. bcrypt cost 12.
- **Rate limiting:** 5 failed login attempts per username per 15 min → temporary lock (403 with generic message; audit row).
- **Reset tokens:** SHA-256 hashed in DB; 24h expiry; single-use.
- **Invite tokens:** 7-day expiry (matching Worthy Products pattern).
- **Storefront cookie:** 120s TTL, HMAC-signed, HttpOnly, SameSite=Lax.
- **Key rotation:** `OidcSigningKey` supports multiple active keys; JWKS endpoint publishes all non-expired public keys. Rotate every 90 days.
- **Backup path:** if the OIDC IdP goes down, Shopify admin has a "disable third-party IdP" toggle that reverts to native OTP. Document runbook step.

## Explicit non-goals for Phase 1

- No SMS OTP (email only).
- No customer self-service username change.
- No admin ability to change an active user's username from the UI (has to be done via DB migration if ever needed).
- No SAML support.
- No customer-facing "manage multiple stores" hub — customers use different usernames or the OTP picker.
- No integration with the Ostendo push/pull pipeline in Phase 1 — that's Phase 2 (webhooks that create `B2BUser` rows when new CompanyContacts land in Shopify).

## Open questions / assumptions to validate

1. **Shopify B2B "which company?" screen** — does Customer Account API actually allow us to set `companyLocationId` for a session programmatically? If not, the pre-select hook has to work differently (possibly a direct redirect to `/collections?location_id=...`). To verify during Milestone 1.
2. **`urn:shopify:customer:tags` claim import** — does it work on the first login (creating the customer) or only on subsequent updates? Milestone 1 test.
3. **App proxy vs custom login route** — is `dutchrusk.co.nz/apps/dr-account/*` free? Confirm before wiring the proxy.
