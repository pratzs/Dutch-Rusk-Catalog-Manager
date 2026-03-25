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
    "zone-bowling-manukau": "147677806905"
  };

  const tagRules = [
    { tag: "hide-bag", keyword: "Bag", catalogs: Object.values(CATALOG_MAPPING) },
    { tag: "hide-block", keyword: "Block", catalogs: ["147677675833"] }, 
    { tag: "hide-each", keyword: "Each", catalogs: ["147677675833"] },   
    { tag: "hide-packet", keyword: "Packet", catalogs: ["147677675833", "147677118777", "147677217081", "147677741369", "147677806905", "147677774137"] },
    { tag: "hide-shipper", keyword: "Shipper", catalogs: ["147677675833", "147677118777", "147677217081", "147677741369"] }
  ];

  try {
    const query = `tag:hide-bag OR tag:hide-block OR tag:hide-each OR tag:hide-packet OR tag:hide-shipper`;
    const response = await admin.graphql(
      `query getProducts($query: String!) {
        products(first: 250, query: $query) {
          nodes {
            id
            tags
            variants(first: 100) {
              nodes {
                id
                title
              }
            }
          }
        }
      }`,
      { variables: { query } }
    );

    const resJson = await response.json();
    const products = resJson.data.products.nodes;
    let createdCount = 0;

    for (const product of products) {
      const productTags = product.tags.map(t => t.toLowerCase());
      for (const rule of tagRules) {
        if (productTags.includes(rule.tag)) {
          const matchingVariants = product.variants.nodes
            .filter(v => v.title.toLowerCase().includes(rule.keyword.toLowerCase()))
            .map(v => v.id);

          if (matchingVariants.length > 0) {
            for (const catalogId of rule.catalogs) {
              await prisma.productOverride.upsert({
                where: { catalogId_productId: { catalogId, productId: product.id } },
                update: { hiddenVariantIds: matchingVariants },
                create: { catalogId, productId: product.id, hiddenVariantIds: matchingVariants }
              });
              createdCount++;
            }
          }
        }
      }
    }
    return { success: true, count: createdCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export default function Migrate() {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== "idle";

  return (
    <div style={{ padding: "40px", background: "white", minHeight: "100vh" }}>
      <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '20px' }}>Migration Tool</h1>
      <p style={{ marginBottom: '20px' }}>This tool will scan Shopify for 'hide-' tags and sync them to your database.</p>
      
      <fetcher.Form method="post">
        <button 
          type="submit" 
          disabled={isLoading} 
          style={{ 
            padding: "12px 24px", 
            backgroundColor: "#008060", 
            color: "white", 
            border: "none", 
            borderRadius: "4px",
            cursor: "pointer" 
          }}
        >
          {isLoading ? "Running Sync..." : "Start Live Sync"}
        </button>
      </fetcher.Form>

      {fetcher.data?.success && (
        <div style={{ marginTop: "20px", color: "green", fontWeight: "bold" }}>
          ✅ Successfully sync'd {fetcher.data.count} visibility rules!
        </div>
      )}
    </div>
  );
}