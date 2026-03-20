import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

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

        {catalogs.length === 0 ? (
          <s-paragraph>
            No catalogs found. Create B2B catalogs in your Shopify admin first.
          </s-paragraph>
        ) : (
          <s-resource-list>
            {catalogs.map((catalog) => {
              const rule = rulesMap[catalog.id];
              const hiddenCount = rule ? rule.hiddenVariantTypes.length : 0;
              return (
                <s-resource-item
                  key={catalog.id}
                  heading={catalog.title}
                  onClick={() =>
                    navigate(
                      `/app/catalog-rules?catalogId=${encodeURIComponent(catalog.id)}&catalogName=${encodeURIComponent(catalog.title)}`
                    )
                  }
                >
                  <span slot="descriptor">
                    Status: {catalog.status} |{" "}
                    {hiddenCount > 0
                      ? `${hiddenCount} variant type(s) hidden`
                      : "No rules set"}
                  </span>
                  <s-button slot="action" variant="secondary">
                    Manage Rules
                  </s-button>
                </s-resource-item>
              );
            })}
          </s-resource-list>
        )}
      </s-section>
    </s-page>
  );
}