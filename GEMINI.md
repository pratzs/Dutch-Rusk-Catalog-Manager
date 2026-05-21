# Dutch Rusk Catalog Manager - Project Instructions

## Architecture & Framework
- **Framework:** React Router v7 (Remix-style). Use loaders, actions, and `useLoaderData`/`useActionData` for data flow.
- **Database:** Prisma with PostgreSQL. Always use the singleton client from `app/db.server.js`.
- **Shopify API:** Use `authenticate.admin(request)` from `app/shopify.server.js` for all authenticated Admin API calls.

## UI Standards
- **Components:** Prioritize **Polaris Web Components** with the `s-` prefix (e.g., `<s-page>`, `<s-layout>`, `<s-button>`).
- **Styling:** Use Vanilla CSS or Polaris-native styling. Avoid introducing new CSS-in-JS libraries.
- **Navigation:** Use `useNavigate` from `react-router` for internal navigation.

## Catalog Management Strategy
- **Visibility Logic:**
  - **Blanket Rules:** Stored in `CatalogRule`. Blocks variant types (titles) globally for a catalog.
  - **Product Overrides:** Stored in `ProductOverride`. Takes precedence over blanket rules for specific products.
- **Sync Engine:** `app/routes/api.catalog-price-sync.jsx` handles syncing price lists to metafields.
- **Shopify Function:** `extensions/b2b-catalog-discount` applies discounts based on metafields.
- **Storefront Hiding:** `extensions/catalog-variant-hider` uses JS on the storefront to hide blocked variants based on the API response from `app/routes/api.catalog-rules.jsx`.

## Development Workflows
- **Migrations:** Run `npx prisma migrate dev` for schema changes.
- **Testing:** Add test cases for new API routes or complex logic in the Shopify Function.
- **Performance:** When querying the Shopify API, use paginated GraphQL queries and optimize for bulk operations (e.g., `metafieldsSet`).
