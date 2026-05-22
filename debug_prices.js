import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) return console.log('No session');

  const query = `
    query GetPriceListPrices($id: ID!) {
      priceList(id: $id) {
        id
        name
        prices(first: 250) {
          nodes {
            price { amount }
            variant { id sku }
          }
        }
      }
    }
  `;

  const response = await fetch(`https://${session.shop}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({ 
      query, 
      variables: { id: 'gid://shopify/PriceList/34326774073' } 
    }),
  });

  const data = await response.json();
  const prices = data.data.priceList.prices.nodes;
  console.log(`Found ${prices.length} prices`);
  console.log(JSON.stringify(prices.slice(0, 10), null, 2));

  const target = prices.find(p => p.variant.id === 'gid://shopify/ProductVariant/43639577215289');
  console.log('Target Variant:', JSON.stringify(target, null, 2));
}

run();
