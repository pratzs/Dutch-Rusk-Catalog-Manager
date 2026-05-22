import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) return;

  const query = `
    query ComparePrices($vId: ID!) {
      global: priceLists(first: 1, query: "name:'Global'") {
        nodes {
          prices(first: 1, query: $vId) { nodes { price { amount } } }
        }
      }
      archie: priceList(id: "gid://shopify/PriceList/34326774073") {
        prices(first: 1, query: $vId) { nodes { price { amount } } }
      }
    }
  `;

  // Variant: Twix 50g x 20ct
  const vGid = "gid://shopify/ProductVariant/43639577215289";

  const response = await fetch(`https://${session.shop}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({ 
      query, 
      variables: { vId: `variant_id:${vGid.split('/').pop()}` } 
    }),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
