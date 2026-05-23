import prisma from './app/db.server.js';

async function run() {
  const customerId = 'gid://shopify/Customer/9340090286393';
  const shop = 'dutchrusk.myshopify.com';
  
  const sessions = await prisma.session.findMany({ where: { shop } });
  console.log('Sessions found:', sessions.length);
  
  const offlineSession = sessions.find(s => !s.isOnline);
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
              catalogs(first: 10) {
                nodes {
                  id
                  title
                  ... on CompanyLocationCatalog {
                    priceList { id }
                  }
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
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": offlineSession.accessToken },
    body: JSON.stringify({ query, variables: { id: customerId } }),
  });
  const data = await res.json();
  console.log('Customer Data Response:', JSON.stringify(data, null, 2));

  if (data.errors) return;

  const profiles = data.data?.customer?.companyContactProfiles ?? [];
  for (const profile of profiles) {
    for (const loc of profile.company?.locations?.nodes ?? []) {
        const mapping = await prisma.locationCatalogMap.findUnique({ where: { locationGid: loc.id } });
        console.log(`\nLocation ${loc.id} (${loc.name})`);
        console.log(`Local mapping found:`, mapping ? mapping.catalogId : 'NONE');
        
        const catalogGids = (loc.catalogs?.nodes ?? []).map(c => c.id);
        console.log(`Shopify Catalogs attached:`, catalogGids.join(', '));

        if (mapping) {
            const rule = await prisma.catalogRule.findUnique({ where: { catalogId: mapping.catalogId } });
            console.log(`Rule lookup for ${mapping.catalogId}:`, rule ? 'FOUND' : 'NOT FOUND');
            
            // Try with full GID
            const fullGid = `gid://shopify/CompanyLocationCatalog/${mapping.catalogId}`;
            const ruleGid = await prisma.catalogRule.findUnique({ where: { catalogId: fullGid } });
            console.log(`Rule lookup for ${fullGid}:`, ruleGid ? 'FOUND' : 'NOT FOUND');
        }
    }
  }
}

run();
