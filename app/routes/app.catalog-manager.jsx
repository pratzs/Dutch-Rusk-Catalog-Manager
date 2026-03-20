import { useLoaderData, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Button,
  Badge,
  EmptyState,
  Text,
  BlockStack,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  // Fetch all catalogs from Shopify
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

  // Fetch existing rules from our database
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

  const rows = catalogs.map((catalog) => {
    const rule = rulesMap[catalog.id];
    const hiddenCount = rule ? rule.hiddenVariantTypes.length : 0;

    return [
      catalog.title,
      <Badge tone={catalog.status === "ACTIVE" ? "success" : "info"}>
        {catalog.status}
      </Badge>,
      hiddenCount > 0 ? (
        <Text tone="caution">{hiddenCount} variant type(s) hidden</Text>
      ) : (
        <Text tone="subdued">No rules set</Text>
      ),
      <Button
        size="slim"
        onClick={() =>
          navigate(
            `/app/catalog-rules?catalogId=${encodeURIComponent(catalog.id)}&catalogName=${encodeURIComponent(catalog.title)}`
          )
        }
      >
        Manage Rules
      </Button>,
    ];
  });

  return (
    <Page
      title="Catalog Variant Manager"
      subtitle="Control which variant types are visible per catalog"
    >
      <Layout>
        <Layout.Section>
          {catalogs.length === 0 ? (
            <Card>
              <EmptyState
                heading="No catalogs found"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Create B2B catalogs in your Shopify admin first.</p>
              </EmptyState>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text variant="headingMd">Your Catalogs ({catalogs.length})</Text>
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Catalog", "Status", "Hidden Variants", "Actions"]}
                  rows={rows}
                />
              </BlockStack>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}