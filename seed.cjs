const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const bag_skus = ["415319_Bag", "DN11218_Bag", "83239_Bag", "473379_Bag", "473365_Bag", "83300_Bag", "83301_Bag", "DN10850_Bag", "DN10851_Bag", "2121342_Bag", "2121343_Bag", "412384_Bag", "5066_Bag", "5067_Bag", "DN11213_Bag", "4328372_Bag", "4328373_Bag", "4328374_Bag", "4223614_Bag", "4331034_Bag", "4323608_Bag", "4323606_Bag", "4323607_Bag", "4225016_Bag", "4225015_Bag", "4314757_Bag"];
const packet_skus = ["4324728_Packet", "4324730_Packet", "4324729_Packet", "4324436_Packet", "4315872_Packet", "4324391_Packet", "4232810_Packet", "4232808_Packet", "4232809_Packet", "4324390_Packet", "4324389_Packet"];
const block_skus = ["4323999_Block", "4228664_Block", "4052788_Block", "4319660_Block", "4319774_Block", "4322437_Block", "4322438_Block", "4322435_Block", "4322436_Block", "4322439_Block", "4252329_Block", "4320150_Block", "4225309_Block", "4321303_Block", "4252328_Block", "4324108_Block", "4320626_Block", "4312847_Block", "4312846_Block", "4320149_Block", "4052786_Block", "4052784_Block", "4052783_Block", "4052782_Block", "4252325_Block", "4312848_Block", "4313271_Block", "4252326_Block", "4319773_Block", "4320625_Block", "4321302_Block", "4320151_Block", "4252327_Block", "4225308_Block", "4319661_Block", "4052781_Block", "4320624_Block", "4052780_Block", "4052787_Block", "4052785_Block", "4323861_Block", "4323681_Block", "4323998_Block", "4323680_Block", "4323860_Block", "4228663_Block", "4312843_Block", "4312845_Block", "4312844_Block", "4322254_Block", "4226359_Block", "4226361_Block", "4226360_Block", "4322255_Block"];
const each_skus = ["M0156_Each"];

const payload = {
  "gid://shopify/AppCatalog/147677086009": { name: "Alexander Marketing", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [] }, 
  "gid://shopify/AppCatalog/147676922169": { name: "General Catalog", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [] }, 
  "gid://shopify/AppCatalog/147677184313": { name: "Holey Moley", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [] }, 
  "gid://shopify/AppCatalog/147677315385": { name: "Night N Day", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [] }, 
  "gid://shopify/AppCatalog/147677708601": { name: "Timezone F&B", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [] }, 
  "gid://shopify/AppCatalog/147677151545": { name: "Hampshire Vending", hiddenVariantTypes: ["Shipper", "Bag", "Packet", "Block", "Each"], hiddenVariantIds: [] }, 
  "gid://shopify/AppCatalog/147677118777": { name: "Archie Brothers", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: bag_skus }, 
  "gid://shopify/AppCatalog/147677217081": { name: "Kingpin Queenstown", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: packet_skus }, 
  "gid://shopify/AppCatalog/147677774137": { name: "Zone Bowling Henderson", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: packet_skus }, 
  "gid://shopify/AppCatalog/147677806905": { name: "Zone Bowling Manukau", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: packet_skus }, 
  "gid://shopify/AppCatalog/147677741369": { name: "Xtreme Wairau", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [...bag_skus, ...packet_skus] }, 
  "gid://shopify/AppCatalog/147677675833": { name: "TEEG", hiddenVariantTypes: ["Shipper"], hiddenVariantIds: [...bag_skus, ...packet_skus, ...block_skus, ...each_skus] } 
};

async function main() {
  for (const [catalogId, rules] of Object.entries(payload)) {
    await prisma.catalogRule.upsert({
      where: { catalogId: catalogId },
      update: {
        catalogName: rules.name,
        hiddenVariantTypes: rules.hiddenVariantTypes,
        hiddenVariantIds: rules.hiddenVariantIds,
      },
      create: {
        catalogId: catalogId,
        catalogName: rules.name,
        hiddenVariantTypes: rules.hiddenVariantTypes,
        hiddenVariantIds: rules.hiddenVariantIds,
      },
    });
    console.log(`✅ Synced rules for ${rules.name} (${catalogId})`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());