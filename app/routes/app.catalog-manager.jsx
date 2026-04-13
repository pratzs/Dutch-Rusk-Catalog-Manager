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

  const [rules, overrideCounts] = await Promise.all([
    prisma.catalogRule.findMany(),
    prisma.productOverride.groupBy({ by: ["catalogId"], _count: { catalogId: true } }),
  ]);

  const rulesMap = {};
  rules.forEach((r) => { rulesMap[r.catalogId] = r; });

  const overrideCountMap = {};
  overrideCounts.forEach((o) => { overrideCountMap[o.catalogId] = o._count.catalogId; });

  // Attempt to sync company location → catalog mappings for the storefront extension.
  // This query uses an inline fragment that may not be supported by all API versions,
  // so it runs in a fully isolated try/catch and never blocks the page load.
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
    // Silently skip — location sync is best-effort only.
  }

  return { catalogs, rulesMap, overrideCountMap, pageInfo };
}

export default function CatalogManager() {
  const { catalogs, rulesMap, overrideCountMap, pageInfo } = useLoaderData();
  const navigate = useNavigate();

  return (
    <s-page heading="B2B Catalog Manager">
      <s-layout>
        <s-layout-section>

          {/* Layman Instructions Panel */}
          <s-box padding="base" background="bg-surface-secondary" borderRadius="base" style={{ marginBottom: '20px', border: '1px solid #e1e3e5' }}>
            <s-block-stack gap="tight">
              <s-text variant="headingMd" as="h2">📖 How to use this tool</s-text>
              <s-text>
                This app controls which products and sizes are <b>visible</b> to specific B2B customers.
              </s-text>
              <ul style={{ paddingLeft: '20px', margin: '10px 0' }}>
                <li><b>Manage Rules:</b> Block entire tags or sizes (e.g., block all "Shipper" sizes) for a catalog.</li>
                <li><b>Product Overrides:</b> Select specific products to manually Show/Hide them for a customer.</li>
              </ul>
              <s-text color="subdued">Note: Any new B2B catalogs created in Shopify will automatically appear in this list.</s-text>
            </s-block-stack>
          </s-box>

          <s-stack direction="inline" gap="base" style={{ marginBottom: "20px", alignItems: "center", justifyContent: "space-between" }}>
            <s-text variant="headingLg" as="h2">Your Active Catalogs</s-text>
            <s-stack direction="inline" gap="tight">
              <s-button variant="secondary" onClick={() => navigate("/app/audit")}>
                Audit Report
              </s-button>
              <s-button variant="primary" onClick={() => navigate("/app/clone")}>
                Clone Rules
              </s-button>
            </s-stack>
          </s-stack>

          <s-stack direction="block" gap="base">
            {catalogs.length === 0 ? (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-paragraph>
                  No B2B catalogs found. Create B2B catalogs in Shopify Admin first.
                </s-paragraph>
              </s-box>
            ) : (
              catalogs.map((catalog) => {
                const cleanId = catalog.id.split("/").pop();
                const rule = rulesMap[cleanId];
                const hiddenTypes = rule?.hiddenVariantTypes || [];
                const overrideCount = overrideCountMap[cleanId] || 0;
                const isConfigured = hiddenTypes.length > 0 || overrideCount > 0;

                return (
                  <s-box key={catalog.id} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                    <s-stack direction="inline" gap="base" align="center">
                      <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                        <s-stack direction="inline" gap="tight" align="center">
                          <s-text fontWeight="bold">{catalog.title}</s-text>
                          {!isConfigured && (
                            <span style={{ fontSize: '11px', background: '#f1f1f1', color: '#6d7175', padding: '2px 8px', borderRadius: '12px', fontWeight: '500' }}>
                              Not configured
                            </span>
                          )}
                        </s-stack>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
                          {hiddenTypes.length > 0 ? (
                            hiddenTypes.map((t) => (
                              <span key={t} style={{ fontSize: '12px', background: '#ffeaeb', color: '#d72c0d', padding: '2px 8px', borderRadius: '12px', fontWeight: '600' }}>
                                🚫 {t}
                              </span>
                            ))
                          ) : (
                            <span style={{ fontSize: '12px', color: '#6d7175' }}>No pack types blocked</span>
                          )}
                          {overrideCount > 0 && (
                            <span style={{ fontSize: '12px', background: '#fff3cd', color: '#856404', padding: '2px 8px', borderRadius: '12px', fontWeight: '600' }}>
                              ✏️ {overrideCount} product exception{overrideCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </s-stack>
                      <s-stack direction="inline" gap="tight">
                        <s-button variant="secondary"
                          onClick={() => navigate(`/app/catalog-rules?catalogId=${encodeURIComponent(catalog.id)}&catalogName=${encodeURIComponent(catalog.title)}`)}>
                          Manage Rules
                        </s-button>
                        <s-button variant="secondary"
                          onClick={() => navigate(`/app/catalog-overrides?catalogId=${encodeURIComponent(catalog.id)}&catalogName=${encodeURIComponent(catalog.title)}`)}>
                          Product Overrides
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-box>
                );
              })
            )}
          </s-stack>

          {(pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
            <s-stack direction="inline" gap="base" style={{ marginTop: "24px", justifyContent: "space-between" }}>
              <s-button
                variant="secondary"
                disabled={!pageInfo.hasPreviousPage}
                onClick={() => navigate(`/app/catalog-manager?before=${pageInfo.startCursor}`)}
              >
                ← Previous
              </s-button>
              <s-button
                variant="secondary"
                disabled={!pageInfo.hasNextPage}
                onClick={() => navigate(`/app/catalog-manager?after=${pageInfo.endCursor}`)}
              >
                Next →
              </s-button>
            </s-stack>
          )}

        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
