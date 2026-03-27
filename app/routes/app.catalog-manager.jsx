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

  const rules = await prisma.catalogRule.findMany();
  const rulesMap = {};
  rules.forEach((r) => {
    rulesMap[r.catalogId] = r;
  });

  return { catalogs, rulesMap, pageInfo };
}

export default function CatalogManager() {
  const { catalogs, rulesMap, pageInfo } = useLoaderData();
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
                const rule = rulesMap[catalog.id.split("/").pop()];
                const hiddenTypes = rule ? rule.hiddenVariantTypes : [];
                const hiddenSkusCount = rule?.hiddenVariantIds?.length || 0;

                return (
                  <s-box
                    key={catalog.id}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-stack direction="inline" gap="base" align="center">
                      <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                        <s-text fontWeight="bold">{catalog.title}</s-text>
                        <s-text tone="subdued">
                          {hiddenTypes.length > 0 ? `Types Blocked: ${hiddenTypes.join(", ")}` : "No bulk types hidden"}
                          {hiddenSkusCount > 0 && (
                            <span style={{ marginLeft: '8px', color: '#bf0711', fontWeight: '600' }}>
                              • {hiddenSkusCount} SKU Exceptions active
                            </span>
                          )}
                        </s-text>
                      </s-stack>
                      <s-stack direction="inline" gap="tight">
                        <s-button
                          variant="secondary"
                          onClick={() =>
                            navigate(
                              `/app/catalog-rules?catalogId=${encodeURIComponent(catalog.id)}&catalogName=${encodeURIComponent(catalog.title)}`
                            )
                          }
                        >
                          Manage Rules
                        </s-button>
                        <s-button
                          variant="secondary"
                          onClick={() =>
                            navigate(
                              `/app/catalog-overrides?catalogId=${encodeURIComponent(catalog.id)}&catalogName=${encodeURIComponent(catalog.title)}`
                            )
                          }
                        >
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
