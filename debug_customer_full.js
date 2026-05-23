import prisma from './app/db.server.js';

async function run() {
  const customerId = 'gid://shopify/Customer/9340090286393';
  const shop = 'dutchrusk.myshopify.com';
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });

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
              catalogs(first: 10) {
                nodes {
                  id
                  title
                }
              }
            } 
          } 
        } 
      } 
    } 
  }`;

  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query, variables: { id: customerId } }),
  });
  const data = await res.json();
  console.log('Customer Data:', JSON.stringify(data, null, 2));

  // Check if any of these locations are in our map
  const profiles = data.data?.customer?.companyContactProfiles ?? [];
  for (const profile of profiles) {
    for (const loc of profile.company?.locations?.nodes ?? []) {
        const mapping = await prisma.locationCatalogMap.findUnique({ where: { locationGid: loc.id } });
        console.log(`Location ${loc.id} (${loc.name}) mapping:`, mapping);
        
        // Also check if catalogId matches any rule
        if (mapping) {
            const rule = await prisma.catalogRule.findUnique({ where: { catalogId: mapping.catalogId } });
            console.log(`Rule for catalog ${mapping.catalogId}:`, rule);
        }
    }
  }
}

run();
