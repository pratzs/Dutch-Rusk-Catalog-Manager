import prisma from './app/db.server.js';

async function catalogIdFromLocationGid(prisma, locationGid) {
  if (!locationGid) return null;
  const normalized = locationGid.includes("/") ? locationGid : `gid://shopify/CompanyLocation/${locationGid}`;
  const mapping = await prisma.locationCatalogMap.findUnique({ where: { locationGid: normalized } });
  return mapping?.catalogId ?? null;
}

async function findRule(prisma, catalogId) {
    if (!catalogId) return null;
    const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
    const rule = await prisma.catalogRule.findFirst({
        where: {
            OR: [
                { catalogId: cleanId },
                { catalogId: `gid://shopify/MarketCatalog/${cleanId}` },
                { catalogId: `gid://shopify/CompanyLocationCatalog/${cleanId}` },
                { catalogId: `gid://shopify/AppCatalog/${cleanId}` }
            ]
        }
    });
    return rule;
}

async function run() {
  const locationId = '18246762809';
  const customerId = '9340090286393';
  const shop = 'dutchrusk.myshopify.com';

  console.log('--- Step 1: Resolve Catalog ID ---');
  let catalogId = await catalogIdFromLocationGid(prisma, locationId);
  console.log('Catalog ID from Location:', catalogId);

  if (!catalogId) {
    console.log('Attempting resolution from customerId...');
    // We already know this might fail in CLI due to token, but let's check local DB first
  }

  if (catalogId) {
    console.log('--- Step 2: Find Rule ---');
    const rule = await findRule(prisma, catalogId);
    console.log('Rule Found:', rule ? `${rule.catalogName} (${rule.catalogId})` : 'NOT FOUND');
    if (rule) {
        console.log('Hidden Types:', rule.hiddenVariantTypes);
    }
  }
}

run();
