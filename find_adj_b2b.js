import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) return;

  const query = `
    query FindAdjustment {
      catalogs(first: 50, type: COMPANY_LOCATION) {
        nodes {
          id
          title
          ... on CompanyLocationCatalog {
            priceList {
              id
              name
              parent {
                adjustment { type value }
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
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
