import prisma from './app/db.server.js';

async function run() {
  const customerId = 'gid://shopify/Customer/9340090286393';
  const shop = 'dutchrusk.myshopify.com';
  
  const offlineSession = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!offlineSession) return console.log('No offline session');
  
  console.log('Using Token:', offlineSession.accessToken.substring(0, 10) + '...');

  const query = `query($id: ID!) { 
    customer(id: $id) { 
      id 
      email
      companyContactProfiles { 
        id
        company { 
          id 
          name
          locations(first: 50) { 
            nodes { 
              id 
              name
            } 
          } 
        } 
      } 
    } 
  }`;

  // Try 2025-10
  const res = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": offlineSession.accessToken },
    body: JSON.stringify({ query, variables: { id: customerId } }),
  });
  const data = await res.json();
  console.log('Customer Data Response:', JSON.stringify(data, null, 2));
}

run();
