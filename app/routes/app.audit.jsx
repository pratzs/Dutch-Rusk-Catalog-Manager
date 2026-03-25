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
    const validGidRegex = /^gid:\/\/shopify\/Product\/\d+$/;

    overrides.forEach((o) => {
      // STRICT REGEX CHECK: Only allow real Product GIDs
      if (!validGidRegex.test(o.productId)) {
        console.log(`Skipping invalid ID found in DB: ${o.productId}`);
        return;
      }

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

    // Extract keys and ensure NO junk data passed to Shopify
    const productGids = Object.keys(reportData).filter(id => id.startsWith("gid://")).slice(0, 250); 
    
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
      
      // If Shopify still complains, catch it here
      if (json.errors) {
        console.error("Shopify GID Error:", json.errors);
        return { report: [], error: "Shopify rejected one or more Product IDs. Clean up invalid entries in the database." };
      }

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