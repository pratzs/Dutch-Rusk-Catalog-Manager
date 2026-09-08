import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Titles that identify Shopify system channels, not B2B catalogs
const SYSTEM_CHANNEL_KEYWORDS = [
  "channel catalog",
  "point of sale",
  "hydrogen",
  "graphiql",
  "online store",
  "buy button",
  "facebook",
  "instagram",
  "google",
  "pinterest",
];

function isSystemChannel(title) {
  const lower = title.toLowerCase();
  return SYSTEM_CHANNEL_KEYWORDS.some(kw => lower.includes(kw));
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  const paginationArgs = before
    ? `last: 50, before: "${before}"`
    : after
    ? `first: 50, after: "${after}"`
    : `first: 50`;

  // Main catalog fetch — plain fields only to avoid API version issues.
  const response = await admin.graphql(`
    query {
      catalogs(${paginationArgs}) {
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes {
          id
          title
          status
        }
      }
    }
  `);

  const data = await response.json();
  const allNodes = data.data.catalogs.nodes;
  const pageInfo = data.data.catalogs.pageInfo;

  // SAFE FILTERING: Exclude known Shopify system channels by title keywords.
  // The 'type' field caused a 500 error in this API version, so title-matching is used.
  const catalogs = allNodes.filter(cat => !isSystemChannel(cat.title));


  // Location sync runs in the background — fire-and-forget so it doesn't block page load.
  (async () => {
    try {
      const locResponse = await admin.graphql(`
        query {
          catalogs(first: 250) {
            nodes {
              id
              ... on CompanyLocationCatalog {
                companyLocations(first: 50) {
                  nodes { id }
                }
              }
            }
          }
        }
      `);
      const locData = await locResponse.json();
      if (!locData.errors) {
        const locationUpserts = [];
        for (const cat of locData.data.catalogs.nodes) {
          const catalogId = cat.id.split("/").pop();
          const locations = cat.companyLocations?.nodes ?? [];
          for (const loc of locations) {
            locationUpserts.push(
              prisma.locationCatalogMap.upsert({
                where: { locationGid: loc.id },
                update: { catalogId },
                create: { locationGid: loc.id, catalogId },
              })
            );
          }
        }
        if (locationUpserts.length > 0) await Promise.all(locationUpserts);
      }
    } catch (_) {
      // best-effort location metadata backfill, ignore failure
    }
  })();

  return { catalogs, pageInfo };
}

export default function CatalogManager() {
  const { catalogs, pageInfo } = useLoaderData();
  const navigate = useNavigate();

  return (
    <s-page heading="B2B Catalog Manager">

      <s-section heading="Where pack sizes are controlled">
        <s-text>
          Pack size visibility is set in <b>Shopify</b>, not here. Open the catalog under Catalogs,
          find the product, and use <b>Exclude from catalog</b> on the individual variant. Shopify
          enforces it, so an excluded size never appears for that customer and cannot be added to a cart.
        </s-text>
        <ul style={{ paddingLeft: '20px', margin: '10px 0 0' }}>
          <li>A product published to a catalog starts with <b>every</b> pack size visible, so exclude the ones that customer should not see when you add it.</li>
          <li>This app no longer holds visibility rules. It handles catalog pricing, the checkout strikethrough prices and BOGO bundles.</li>
        </ul>
        <s-text tone="subdued">Any new B2B catalogs created in Shopify will automatically appear in this list.</s-text>
      </s-section>

      <s-section heading="Your Active Catalogs">
        <s-stack direction="block" gap="base">
          {catalogs.length === 0 ? (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text>No B2B catalogs found. Create B2B catalogs in Shopify Admin first.</s-text>
            </s-box>
          ) : (
            catalogs.map((catalog) => (
              <s-box key={catalog.id} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <s-stack direction="inline" gap="base" align="center">
                  <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                    <s-text fontWeight="bold">{catalog.title}</s-text>
                    <s-text tone="subdued">
                      Pack size visibility for this catalog is set in Shopify, under Catalogs, by excluding
                      individual variants from it.
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-box>
            ))
          )}
        </s-stack>

        {(pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '16px' }}>
            <s-button variant="secondary" disabled={!pageInfo.hasPreviousPage}
              onClick={() => navigate(`/app/catalog-manager?before=${pageInfo.startCursor}`)}>
              ← Previous
            </s-button>
            <s-button variant="secondary" disabled={!pageInfo.hasNextPage}
              onClick={() => navigate(`/app/catalog-manager?after=${pageInfo.endCursor}`)}>
              Next →
            </s-button>
          </div>
        )}
      </s-section>

    </s-page>
  );
}
