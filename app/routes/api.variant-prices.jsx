// app/routes/api.variant-prices.jsx
// Public API called by the checkout UI extension to get variant compare_at prices.
// Accepts ?variantIds=gid://...&shop=xxx.myshopify.com
import prisma from "../db.server";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const variantIdsParam = url.searchParams.get("variantIds");
  const shop = url.searchParams.get("shop");

  if (!variantIdsParam || !shop) {
    return new Response(
      JSON.stringify({ error: "Missing variantIds or shop" }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const variantIds = variantIdsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) =>
      id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`
    );

  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });

  if (!session?.accessToken) {
    return new Response(
      JSON.stringify({ error: "No session found for shop" }),
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const query = `
    query GetVariantPrices($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          compareAtPrice
        }
      }
    }
  `;

  let prices = {};
  try {
    const res = await fetch(
      `https://${shop}/admin/api/2026-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query, variables: { ids: variantIds } }),
      }
    );

    const { data } = await res.json();
    for (const node of data?.nodes ?? []) {
      if (node?.id) {
        prices[node.id] = {
          price: node.price,
          compareAtPrice: node.compareAtPrice ?? null,
        };
      }
    }
  } catch (err) {
    console.error("[variant-prices] Admin API error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch variant prices" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }

  return new Response(JSON.stringify({ prices }), {
    status: 200,
    headers: CORS_HEADERS,
  });
}
