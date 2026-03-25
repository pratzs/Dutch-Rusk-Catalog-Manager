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
    
    // 1. FILTER: Only allow IDs that are correctly formatted GIDs
    const validOverrides = overrides.filter(o => 
      o.productId && 
      o.productId.startsWith("gid://shopify/Product/")
    );

    validOverrides.forEach((o) => {
      if (!reportData[o.productId]) {
        reportData[o.productId] = {
          productId: o.productId,
          catalogs: [],
          hiddenVariantCount: 0,
          title: "Product ID: " + o.productId.split("/").pop() // Fallback title
        };
      }
      
      const catName = catalogMap[o.catalogId] || `Catalog ${o.catalogId}`;
      if (!reportData[o.productId].catalogs.includes(catName)) {
        reportData[o.productId].catalogs.push(catName);
      }
      
      reportData[o.productId].hiddenVariantCount += o.hiddenVariantIds.length;
    });

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
      
      const resJson = await response.json();
      
      // 2. CHECK: If Shopify returns any errors, we just skip the titles 
      // instead of crashing the whole page.
      if (!resJson.errors && resJson.data?.nodes) {
        resJson.data.nodes.forEach(node => {
          if (node && node.id && reportData[node.id]) {
            reportData[node.id].title = node.title;
          }
        });
      }
    }

    const formattedReport = Object.values(reportData).sort((a, b) => a.title.localeCompare(b.title));

    // Return a plain object (The safest way in RRv7)
    return { report: formattedReport, error: null };
  } catch (error) {
    console.error("Audit Loader Fatal Error:", error);
    return { report: [], error: "A server error occurred. Check Render logs." };
  }
}