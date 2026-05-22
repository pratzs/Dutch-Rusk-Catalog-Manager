import prisma from './app/db.server.js';

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'dutchrusk.myshopify.com', isOnline: false }
  });

  if (!session) {
    console.log('No session found');
    return;
  }

  const query = `
    query IntrospectB2B {
      priceListFields: __type(name: "PriceList") {
        fields {
          name
          type {
            name
            kind
            fields {
              name
              type { name kind }
            }
          }
        }
      }
      catalogFields: __type(name: "Catalog") {
        fields {
          name
          type { name kind }
        }
      }
      marketCatalogFields: __type(name: "MarketCatalog") {
        fields {
          name
          type { name kind }
        }
      }
      companyLocationCatalogFields: __type(name: "CompanyLocationCatalog") {
        fields {
          name
          type { name kind }
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
