const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// The specific SKUs from your 'hide-bag', 'hide-packet', etc. tags
const restricted_skus = ["415319_Bag", "DN11218_Bag", "83239_Bag", "473379_Bag", "473365_Bag", "83300_Bag", "83301_Bag", "DN10850_Bag", "DN10851_Bag", "2121342_Bag", "2121343_Bag", "412384_Bag", "5066_Bag", "5067_Bag", "DN11213_Bag", "4328372_Bag", "4328373_Bag", "4328374_Bag", "4223614_Bag", "4331034_Bag", "4323608_Bag", "4323606_Bag", "4323607_Bag", "4225016_Bag", "4225015_Bag", "4314757_Bag"];

async function main() {
  const catalogs = [
    { id: "147677675833", name: "TEEG", types: ["Shipper"], skus: restricted_skus },
    { id: "147677741369", name: "Xtreme Wairau", types: ["Shipper"], skus: restricted_skus },
    { id: "147677118777", name: "Archie Brothers", types: ["Shipper"], skus: restricted_skus },
    { id: "147677217081", name: "Kingpin Queenstown", types: ["Shipper"], skus: restricted_skus },
    { id: "147677806905", name: "Zone Bowling Manukau", types: ["Shipper"], skus: restricted_skus },
    { id: "147677774137", name: "Zone Bowling Henderson", types: ["Shipper"], skus: restricted_skus },
    // Night 'n Day and General stay open (no SKUs) as per Locksmith "Permit" rules
    { id: "147677315385", name: "Night N Day", types: ["Shipper"], skus: [] },
    { id: "147676922169", name: "General Catalog", types: [], skus: [] }
  ];

  for (const cat of catalogs) {
    await prisma.catalogRule.upsert({
      where: { catalogId: cat.id },
      update: { hiddenVariantTypes: cat.types, hiddenVariantIds: cat.skus },
      create: { catalogId: cat.id, catalogName: cat.name, hiddenVariantTypes: cat.types, hiddenVariantIds: cat.skus }
    });
  }
  console.log("✅ All Catalog Locks Synced to Locksmith Standards.");
}

main().catch(console.error).finally(() => prisma.$disconnect());