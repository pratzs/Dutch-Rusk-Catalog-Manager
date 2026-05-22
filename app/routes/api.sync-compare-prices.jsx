// app/routes/api.sync-compare-prices.jsx

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);

  const body = await request.json().catch(() => ({}));
  const cursor = body.cursor ?? null;

  let updatedCount = 0;

  try {
    const productsRes = await admin.graphql(
      `query GetProducts($cursor: String) {
        products(first: 25, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            variants(first: 100) {
              nodes {
                id
                price
                compareAtPrice
              }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );

    const { data, errors } = await productsRes.json();
    if (errors) return Response.json({ error: "Query failed" }, { status: 500 });

    const page = data?.products;
    if (!page) return Response.json({ success: true, updatedCount: 0, done: true });

    await Promise.all(
      page.nodes.map(async (product) => {
        const variantInputs = product.variants.nodes.map((v) => ({
          id: v.id,
          compareAtPrice: v.price,
          metafields: [{
            namespace: "custom",
            key: "retail_price",
            value: v.price,
            type: "number_decimal",
          }],
        }));

        await admin.graphql(
          `mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          { variables: { productId: product.id, variants: variantInputs } }
        );
        updatedCount += variantInputs.length;
      })
    );

    return Response.json({
      success: true,
      updatedCount,
      done: !page.pageInfo.hasNextPage,
      nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
