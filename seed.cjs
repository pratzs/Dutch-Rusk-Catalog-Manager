const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// The specific SKUs we need to hide for TEEG/Xtreme based on your export
const teeg_skus = ["415319_Bag", "DN11218_Bag", "83239_Bag", "473379_Bag", "473365_Bag", "83300_Bag", "83301_Bag", "DN10850_Bag", "DN10851_Bag", "2121342_Bag", "2121343_Bag", "412384_Bag", "5066_Bag", "5067_Bag", "DN11213_Bag", "4328372_Bag", "4328373_Bag", "4328374_Bag", "4223614_Bag", "4331034_Bag", "4323608_Bag", "4323606_Bag", "4323607_Bag", "4225016_Bag", "4225015_Bag", "4314757_Bag"];

async function main() {
  console.log("Starting final sync...");

  // We are using the numeric IDs that your app uses for lookups
  const catalogs = [
    { id: "147677675833", name: "TEEG", types: ["Shipper"], skus: teeg_skus },
    { id: "147677315385", name: "Night N Day", types: ["Shipper"], skus: [] },
    { id: "147676922169", name: "General Catalog", types: [], skus: [] },
    { id: "147677086009", name: "Alexander Marketing", types: ["Shipper"], skus: [] },
    { id: "147677741369", name: "Xtreme Wairau", types: ["Shipper"], skus: teeg_skus }
  ];

  for (const cat of catalogs) {
    await prisma.catalogRule.upsert({
      where: { catalogId: cat.id },
      update: {
        catalogName: cat.name,
        hiddenVariantTypes: cat.types,
        hiddenVariantIds: cat.skus
      },
      create: {
        catalogId: cat.id,
        catalogName: cat.name,
        hiddenVariantTypes: cat.types,
        hiddenVariantIds: cat.skus
      }
    });
    console.log(`✅ Synced: ${cat.name} (${cat.id})`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });