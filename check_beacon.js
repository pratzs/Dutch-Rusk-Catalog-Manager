import prisma from './app/db.server.js';

async function run() {
  const shop = 'dutchrusk.myshopify.com';
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });

  const query = `query($q: String) { 
    products(first: 5, query: $q) { 
      nodes { 
        id 
        title 
      } 
    } 
  }`;

  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query, variables: { q: 'Beacon' } }),
  });
  const data = await res.json();
  console.log('Products:', JSON.stringify(data, null, 2));

  if (data.data?.products?.nodes?.length > 0) {
      const productId = data.data.products.nodes[0].id;
      const override = await prisma.productOverride.findUnique({
          where: { catalogId_productId: { catalogId: '147677118777', productId } }
      });
      console.log('Override for Beacon:', JSON.stringify(override, null, 2));
  }
}

run();
