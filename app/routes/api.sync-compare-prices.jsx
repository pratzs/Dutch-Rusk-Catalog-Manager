// app/routes/api.sync-compare-prices.jsx
// Sets compare_at_price = price for every variant that has no compare_at_price.
// This lets the checkout UI extension show ~~retail price~~ catalog price for B2B customers.
import { authenticate } from "../shopify.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  let updatedCount = 0;
  let productCursor = null;
  let hasNextProductPage = true;

  try {
    while (hasNextProductPage) {
      // Query products + their variants
      const productsRes = await admin.graphql(
        `query GetProducts($cursor: String) {
          products(first: 10, after: $cursor) {
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
        { variables: { cursor: productCursor } }
      );

      const { data, errors } = await productsRes.json();

      if (errors) {
        console.error("[sync-compare-prices] Query errors:", JSON.stringify(errors));
        return Response.json({ error: "Failed to query products: " + errors[0]?.message }, { status: 500 });
      }

      const page = data?.products;
      if (!page) break;

      hasNextProductPage = page.pageInfo.hasNextPage;
      productCursor = page.pageInfo.endCursor;

      for (const product of page.nodes) {
        // Only update variants where compareAtPrice is null/empty
        const needsUpdate = product.variants.nodes.filter(
          (v) => !v.compareAtPrice || v.compareAtPrice === "0.00" || parseFloat(v.compareAtPrice) === 0
        );

        if (needsUpdate.length === 0) continue;

        const variantInputs = needsUpdate.map((v) => ({
          id: v.id,
          compareAtPrice: v.price,
        }));

        const mutRes = await admin.graphql(
          `mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          { variables: { productId: product.id, variants: variantInputs } }
        );

        const mutData = await mutRes.json();
        const userErrors = mutData?.data?.productVariantsBulkUpdate?.userErrors ?? [];

        if (userErrors.length > 0) {
          console.error("[sync-compare-prices] userErrors for product", product.id, JSON.stringify(userErrors));
          // Continue with other products rather than aborting
        } else if (mutData.errors) {
          console.error("[sync-compare-prices] GraphQL errors:", JSON.stringify(mutData.errors));
        } else {
          updatedCount += variantInputs.length;
        }
      }
    }
  } catch (err) {
    console.error("[sync-compare-prices] Unexpected error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }

  return Response.json({ success: true, updatedCount });
}
