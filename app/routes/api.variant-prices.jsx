// app/routes/api.variant-prices.jsx

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const priceListId = url.searchParams.get("id");
  const variantId = url.searchParams.get("variantId");

  if (!priceListId) return { error: "Missing id param" };

  const response = await admin.graphql(`
    query GetPriceList($id: ID!, $vId: ID) {
      priceList(id: $id) {
        id
        name
        parent {
          adjustment {
            type
            value
          }
        }
        prices(first: 10, query: $vId) {
          nodes {
            price {
              amount
            }
            variant {
              id
              sku
              displayName
            }
          }
        }
      }
    }
  `, {
    variables: { id: priceListId, vId: variantId ? `variant_id:${variantId.split('/').pop()}` : null }
  });

  const data = await response.json();
  return data;
}
