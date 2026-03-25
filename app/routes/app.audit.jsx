export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const [overrides, catalogs] = await Promise.all([
      prisma.productOverride.findMany(),
      prisma.catalogRule.findMany()
    ]);

    const catalogMap = catalogs.reduce((acc, cat) => {
      acc[cat.catalogId] = cat.catalogName;
      return acc;
    }, {});

    const reportData = {};
    overrides.forEach((o) => {
      // SAFETY CHECK: Only process real Shopify Product GIDs
      if (!o.productId.includes("gid://shopify/Product/")) return;

      if (!reportData[o.productId]) {
        reportData[o.productId] = {
          productId: o.productId,
          catalogs: [],
          hiddenVariantCount: 0,
          title: "Product Not Found"
        };
      }
      
      const catName = catalogMap[o.catalogId] || `Catalog ${o.catalogId}`;
      if (!reportData[o.productId].catalogs.includes(catName)) {
        reportData[o.productId].catalogs.push(catName);
      }
      
      reportData[o.productId].hiddenVariantCount += o.hiddenVariantIds.length;
    });

    // Only query Shopify for the valid GIDs we found
    const productGids = Object.keys(reportData).slice(0, 250); 
    
    if (productGids.length > 0) {
      const response = await admin.graphql(
        `query getProductTitles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product { id title }
          }
        }`,
        { variables: { ids: productGids } }
      );
      
      const json = await response.json();
      const nodes = json.data?.nodes || [];
      
      nodes.forEach(node => {
        if (node && node.id && reportData[node.id]) {
          reportData[node.id].title = node.title;
        }
      });
    }

    const formattedReport = Object.values(reportData).sort((a, b) => a.title.localeCompare(b.title));

    return { report: formattedReport, error: null };
  } catch (error) {
    console.error("Audit Loader Error:", error);
    return { report: [], error: error.message };
  }
}