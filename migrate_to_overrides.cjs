const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. Get all the rules we seeded into CatalogRule
  const rules = await prisma.catalogRule.findMany();

  for (const rule of rules) {
    if (rule.hiddenVariantIds.length > 0) {
      console.log(`Migrating ${rule.hiddenVariantIds.length} SKUs for ${rule.catalogName}...`);
      
      // 2. Create a "Global Exception" override for this catalog
      // We use a special ID so it shows up in your overrides logic
      await prisma.productOverride.upsert({
        where: {
          catalogId_productId: {
            catalogId: rule.catalogId,
            productId: "GLOBAL_MIGRATION"
          }
        },
        update: { hiddenVariantIds: rule.hiddenVariantIds },
        create: {
          catalogId: rule.catalogId,
          productId: "GLOBAL_MIGRATION",
          hiddenVariantIds: rule.hiddenVariantIds
        }
      });

      // 3. Clean up the CatalogRule table so the homepage count resets
      await prisma.catalogRule.update({
        where: { id: rule.id },
        data: { hiddenVariantIds: [] }
      });
    }
  }
  console.log("✅ All Locksmith data moved to Product Overrides.");
}

main().catch(console.error).finally(() => prisma.$disconnect());