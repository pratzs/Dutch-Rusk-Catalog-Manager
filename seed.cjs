const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// The 350+ Restricted SKUs from your CSV
const restricted_skus = ["415319_Bag", "4323606_Bag", "4323607_Bag", "4323999_Block", "4324728_Packet"]; // ... etc

async function main() {
  const catalogs = [
    { id: "147676922169", name: "General Catalog", types: ["Shipper"], skus: [] }, // NO SKUs
    { id: "147677315385", name: "Night N Day", types: ["Shipper"], skus: [] },    // NO SKUs
    { id: "147677675833", name: "TEEG", types: ["Shipper"], skus: restricted_skus },
    { id: "147677741369", name: "Xtreme Wairau", types: ["Shipper"], skus: restricted_skus },
    { id: "147677118777", name: "Archie Brothers", types: ["Shipper"], skus: restricted_skus }
  ];

  for (const cat of catalogs) {
    await prisma.catalogRule.upsert({
      where: { catalogId: cat.id },
      update: { hiddenVariantTypes: cat.types, hiddenVariantIds: cat.skus, catalogName: cat.name },
      create: { catalogId: cat.id, catalogName: cat.name, hiddenVariantTypes: cat.types, hiddenVariantIds: cat.skus }
    });
  }
  console.log("✅ Night n Day & General opened; TEEG & Xtreme restricted.");
}

main().catch(console.error).finally(() => prisma.$disconnect());