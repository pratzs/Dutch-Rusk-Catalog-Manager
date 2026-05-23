import prisma from './app/db.server.js';

async function run() {
  const shop = 'dutchrusk.myshopify.com';
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });

  if (!session) return console.log('No session');

  const query = `query GetB2BStructure {
    companyLocations(first: 50) {
      nodes {
        id
        name
        company { id name }
        catalogs(first: 5) {
          nodes {
            id
            title
          }
        }
      }
    }
  }`;

  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  
  if (data.errors) return console.log('Error:', JSON.stringify(data.errors, null, 2));

  const locations = data.data.companyLocations.nodes;
  console.log(`--- SCANNING ${locations.length} LOCATIONS ---`);
  
  for (const loc of locations) {
      const catalogs = loc.catalogs.nodes;
      console.log(`\nLocation: ${loc.name} (${loc.id})`);
      console.log(`Company: ${loc.company.name}`);
      for (const cat of catalogs) {
          console.log(` - Assigned Catalog: ${cat.title} (${cat.id})`);
          
          // Update DB mapping while we are at it
          const catalogId = cat.id.split("/").pop();
          await prisma.locationCatalogMap.upsert({
              where: { locationGid: loc.id },
              update: { catalogId },
              create: { locationGid: loc.id, catalogId }
          });
      }
  }
}

run();
