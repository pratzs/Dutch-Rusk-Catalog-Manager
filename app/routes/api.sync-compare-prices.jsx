// app/routes/api.sync-compare-prices.jsx
// Sets compare_at_price = price for variants missing a compare_at_price.
// Supports cursor-based pagination — each POST processes one page of 25 products
// in parallel, then returns a nextCursor. The UI keeps calling until done.
import { authenticate } from "../shopify.server";

export async function action({ request }) {
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

    if (errors) {
      console.error("[sync-compare-prices] Query errors:", JSON.stringify(errors));
      return Response.json({ error: "Query failed: " + errors[0]?.message }, { status: 500 });
    }

    const page = data?.products;
    if (!page) return Response.json({ success: true, updatedCount: 0, done: true });

    // Process all products on this page in PARALLEL
    await Promise.all(
      page.nodes.map(async (product) => {
        const needsUpdate = product.variants.nodes.filter(
          (v) => !v.compareAtPrice || parseFloat(v.compareAtPrice) === 0
        );
        if (needsUpdate.length === 0) return;

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
          console.error("[sync-compare-prices] userErrors:", JSON.stringify(userErrors));
        } else if (!mutData.errors) {
          updatedCount += variantInputs.length;
        }
      })
    );

    return Response.json({
      success: true,
      updatedCount,
      done: !page.pageInfo.hasNextPage,
      nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
    });
  } catch (err) {
    console.error("[sync-compare-prices] Error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
