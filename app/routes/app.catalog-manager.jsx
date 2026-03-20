import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query {
      catalogs(first: 50) {
        nodes {
          id
          title
          status
        }
      }
    }
  `);

  const data = await response.json();
  const catalogs = data.data.catalogs.nodes;

  const rules = await prisma.catalogRule.findMany();
  const rulesMap = {};
  rules.forEach((r) => {
    rulesMap[r.catalogId] = r;
  });

  return { catalogs, rulesMap };
}

export default function CatalogManager() {
  const { catalogs, rulesMap } = useLoaderData();
  const navigate = useNavigate();

  return (
    <s-page heading="Catalog Variant Manager">
      <s-section heading="Your Catalogs">
        <s-paragraph>
          Select a catalog to manage which variant types are hidden from its customers.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          {catalogs.length === 0 ? (
            <s-paragraph>
              No catalogs found. Create B2B catalogs in your Shopify admin first.
            </s-paragraph>
          ) : (
            catalogs.map((catalog) => {
              const rule = rulesMap[catalog.id];
              const hiddenTypes = rule ? rule.hiddenVariantTypes : [];
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
                      <s-text>
                        {hiddenTypes.length > 0
                          ? `Hiding: ${hiddenTypes.join(", ")}`
                          : "No rules set — all variants visible"}
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
      </s-section>
    </s-page>
  );
}