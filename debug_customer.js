import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) return console.log('No session');

  const query = `
    query GetCustomerCompanies($id: ID!) {
      customer(id: $id) {
        id
        firstName
        lastName
        companyContactProfiles {
          id
          company {
            id
            name
            locations(first: 50) {
              nodes {
                id
                name
                catalogs(first: 10) {
                  nodes {
                    id
                    title
                    priceList { id name }
                  }
                }
              }
            }
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
      variables: { id: 'gid://shopify/Customer/9340090286393' } 
    }),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
