import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) return;

  const query = `
    query ComparePrices($vQuery: String!) {
      priceLists(first: 20) {
        nodes {
          id
          name
          prices(first: 1, query: $vQuery) { nodes { price { amount } } }
        }
      }
    }
  `;

  const vGid = "gid://shopify/ProductVariant/43639577215289";

  const response = await fetch(`https://${session.shop}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({ 
      query, 
      variables: { vQuery: `variant_id:${vGid.split('/').pop()}` } 
    }),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
