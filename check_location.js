import prisma from './app/db.server.js';

async function run() {
  const shop = 'dutchrusk.myshopify.com';
  const locationId = 'gid://shopify/CompanyLocation/18246762809';
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });

  if (!session) return console.log('No session');

  const query = `query($id: ID!) { 
    companyLocation(id: $id) { 
      id 
      name
      company { id name }
      catalogs(first: 10) {
        nodes {
          id
          title
        }
      }
    } 
  }`;

  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query, variables: { id: locationId } }),
  });
  const data = await res.json();
  console.log('definitive_shopify_location_data:', JSON.stringify(data, null, 2));
}

run();
