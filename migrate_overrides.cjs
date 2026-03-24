const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// The list of SKUs we want to move to the "Overrides" UI
const bag_skus = ["415319_Bag", "DN11218_Bag", "83239_Bag", "473379_Bag", "473365_Bag", "83300_Bag", "83301_Bag", "DN10850_Bag", "DN10851_Bag", "2121342_Bag", "2121343_Bag", "412384_Bag", "5066_Bag", "5067_Bag", "DN11213_Bag", "4328372_Bag", "4328373_Bag", "4328374_Bag", "4223614_Bag", "4331034_Bag", "4323608_Bag", "4323606_Bag", "4323607_Bag", "4225016_Bag", "4225015_Bag", "4314757_Bag"];

async function main() {
  // We'll clean up the CatalogRule (remove IDs from there)
  await prisma.catalogRule.updateMany({
    data: { hiddenVariantIds: [] }
  });

  // Example: Pushing TEEG bag overrides
  // Note: Your UI likely expects a 'productId' to show them. 
  // If you have a specific product you want to test, put its ID here.
  await prisma.productOverride.upsert({
    where: { 
      catalogId_productId: { 
        catalogId: "147677675833", 
        productId: "GLOBAL_EXCEPTIONS" 
      } 
    },
    update: { hiddenVariantIds: bag_skus },
    create: { 
      catalogId: "147677675833", 
      productId: "GLOBAL_EXCEPTIONS", 
      hiddenVariantIds: bag_skus 
    },
  });

  console.log("✅ Moved SKUs to Product Overrides table");
}

main().catch(console.error).finally(() => prisma.$disconnect());