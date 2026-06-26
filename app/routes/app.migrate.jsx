import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const CATALOG_MAPPING = {
    "teeg": "147677675833",
    "archie-brothers": "147677118777",
    "kingpin-queenstown": "147677217081",
    "night-n-day": "147677315385",
    "holey-moley": "147677184313",
    "alexander-marketing": "147677086009",
    "xtreme-wairau": "147677741369",
    "zone-bowling-henderson": "147677774137",
    "zone-bowling-manukau": "147677806905",
  };

  const tagRules = [
    { tag: "hide-bag",     keyword: "Bag",     catalogs: Object.values(CATALOG_MAPPING) },
    { tag: "hide-block",   keyword: "Block",   catalogs: ["147677675833"] },
    { tag: "hide-each",    keyword: "Each",    catalogs: ["147677675833"] },
    { tag: "hide-packet",  keyword: "Packet",  catalogs: ["147677675833", "147677118777", "147677217081", "147677741369", "147677806905", "147677774137"] },
    { tag: "hide-shipper", keyword: "Shipper", catalogs: ["147677675833", "147677118777", "147677217081", "147677741369"] },
  ];

  try {
    const tagQuery = `tag:hide-bag OR tag:hide-block OR tag:hide-each OR tag:hide-packet OR tag:hide-shipper`;

    // Paginate through ALL matching products — not just the first 250.
    let allProducts = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const afterArg = cursor ? `, after: "${cursor}"` : "";
      const response = await admin.graphql(
        `query getProducts($query: String!) {
          products(first: 250, query: $query${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              tags
              variants(first: 100) {
                nodes { id title }
              }
            }
          }
        }`,
        { variables: { query: tagQuery } }
      );

      const resJson = await response.json();
      if (resJson.errors) throw new Error(JSON.stringify(resJson.errors));

      const page = resJson.data.products;
      allProducts = allProducts.concat(page.nodes);
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }

    let createdCount = 0;

    for (const product of allProducts) {
      const productTags = product.tags.map((t) => t.toLowerCase());
      for (const rule of tagRules) {
        if (productTags.includes(rule.tag)) {
          const matchingVariants = product.variants.nodes
            .filter((v) => v.title.toLowerCase().includes(rule.keyword.toLowerCase()))
            .map((v) => v.id);

          if (matchingVariants.length > 0) {
            for (const catalogId of rule.catalogs) {
              await prisma.productOverride.upsert({
                where: { catalogId_productId: { catalogId, productId: product.id } },
                update: { hiddenVariantIds: matchingVariants },
                create: { catalogId, productId: product.id, hiddenVariantIds: matchingVariants },
              });
              createdCount++;
            }
          }
        }
      }
    }

    return { success: true, count: createdCount, total: allProducts.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export default function Migrate() {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== "idle";
  const result = fetcher.data;

  return (
    <s-page heading="Migration Tool" back-action-url="/app/catalog-manager">

      <s-section heading="Tag-to-Override Sync">
        <s-text>
          Scans <b>all</b> Shopify products tagged with <code>hide-bag</code>,{" "}
          <code>hide-block</code>, <code>hide-each</code>, <code>hide-packet</code>, or{" "}
          <code>hide-shipper</code> and writes the corresponding visibility rules to the database.
        </s-text>
        <div style={{ marginTop: "6px", padding: "10px 12px", background: "#fff4f4", border: "1px solid #ffd2d2", borderRadius: "6px" }}>
          <s-text color="critical">
            This will overwrite existing product overrides for any product that has a
            hide-* tag. Run this only when syncing from the legacy tagging system.
          </s-text>
        </div>
      </s-section>

      <s-section heading="Run Sync">
        {result?.success && (
          <div style={{ marginBottom: "16px", padding: "16px", background: "#f1f8f5", border: "1px solid #95c9b4", borderRadius: "8px" }}>
            <s-text fontWeight="bold" style={{ color: "#008060" }}>Sync complete</s-text>
            <s-text>
              Scanned <b>{result.total}</b> product{result.total !== 1 ? "s" : ""} — wrote{" "}
              <b>{result.count}</b> visibility rule{result.count !== 1 ? "s" : ""} to the database.
            </s-text>
          </div>
        )}

        {result?.success === false && (
          <div style={{ marginBottom: "16px", padding: "16px", background: "#fff4f4", border: "1px solid #ffd2d2", borderRadius: "8px" }}>
            <s-text fontWeight="bold" style={{ color: "#d72c0d" }}>Sync failed</s-text>
            <s-text color="critical">{result.error}</s-text>
          </div>
        )}

        <s-text>
          Click the button below to start the sync. Large stores may take a minute or two while
          all pages of products are fetched.
        </s-text>
        <fetcher.Form method="post">
          <s-button variant="primary" type="submit" disabled={isLoading || undefined}>
            {isLoading ? "Running sync…" : "Start Live Sync"}
          </s-button>
        </fetcher.Form>
      </s-section>

    </s-page>
  );
}
