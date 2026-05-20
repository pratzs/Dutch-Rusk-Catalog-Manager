// app/routes/api.sync-compare-prices.jsx
// Sets compare_at_price = price for every variant that has no compare_at_price.
// This lets the checkout UI extension show strikethrough prices for B2B catalog customers
// without needing network_access approval, because compareAtAmountPerQuantity becomes
// populated (regular retail price) while B2B customers pay the lower catalog price.
import { authenticate } from "../shopify.server";

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  let updatedCount = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query GetVariants($cursor: String) {
        productVariants(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            price
            compareAtPrice
          }
        }
      }
    `;

    const res = await admin.graphql(query, { variables: { cursor } });
    const { data } = await res.json();
    const page = data?.productVariants;
    if (!page) break;

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;

    // Only update variants where compareAtPrice is null or empty
    const needsUpdate = page.nodes.filter(
      (v) => !v.compareAtPrice || parseFloat(v.compareAtPrice) === 0
    );

    if (needsUpdate.length === 0) continue;

    // Batch update in chunks of 100
    const mutation = `
      mutation BulkUpdateVariants($variants: [ProductVariantsBulkInput!]!, $productId: ID!) {
        productVariantsBulkUpdate(variants: $variants, productId: $productId) {
          userErrors { field message }
        }
      }
    `;

    // Group by product (required by productVariantsBulkUpdate)
    const byProduct = {};
    for (const v of needsUpdate) {
      // Extract product GID from variant GID
      // variant: gid://shopify/ProductVariant/123 → need product GID
      // We'll use a single-variant mutation approach instead
      const updateMutation = `
        mutation UpdateVariant($id: ID!, $compareAtPrice: Money!) {
          productVariantUpdate(input: { id: $id, compareAtPrice: $compareAtPrice }) {
            userErrors { field message }
          }
        }
      `;
      await admin.graphql(updateMutation, {
        variables: { id: v.id, compareAtPrice: v.price },
      });
      updatedCount++;
    }
  }

  return Response.json({ success: true, updatedCount });
}
