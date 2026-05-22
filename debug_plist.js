import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) return console.log('No session');

  const query = `
    query GetSpecificPriceList($id: ID!) {
      priceList(id: $id) {
        id
        name
        parent {
          adjustment { type value }
        }
        catalog {
          id
          title
          ... on CompanyLocationCatalog {
            companyLocations(first: 5) { nodes { company { id name } } }
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
  console.log(JSON.stringify(data, null, 2));
}

run();
