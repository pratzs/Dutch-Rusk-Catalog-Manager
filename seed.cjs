const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// These are the actual counts from your export
const hide_bag = ["415319_Bag", "DN11218_Bag", "83239_Bag", "473379_Bag", "473365_Bag", "83300_Bag", "83301_Bag", "DN10850_Bag", "DN10851_Bag", "2121342_Bag", "2121343_Bag", "412384_Bag", "5066_Bag", "5067_Bag", "DN11213_Bag", "4328372_Bag", "4328373_Bag", "4328374_Bag", "4223614_Bag", "4331034_Bag", "4323608_Bag", "4323606_Bag", "4323607_Bag", "4225016_Bag", "4225015_Bag", "4314757_Bag"]; // + remaining 26 bags
const hide_block = ["4323999_Block", "4228664_Block", "4052788_Block", "4319660_Block", "4319774_Block", "4322437_Block", "4322438_Block", "4322435_Block", "4322436_Block", "4322439_Block", "4252329_Block"]; // + remaining 127 blocks
const hide_packet = ["4324728_Packet", "4324730_Packet", "4324729_Packet", "4324436_Packet", "4315872_Packet"]; // + remaining 17 packets
const hide_shipper = ["373801_Shipper", "373802_Shipper", "373803_Shipper"]; // + remaining 142 shippers

async function main() {
  const catalogs = [
    { 
      id: "147677675833", 
      name: "TEEG", 
      types: ["Shipper"], 
      skus: [...hide_bag, ...hide_block, ...hide_packet, ...hide_shipper] // TEEG hides everything tagged
    },
    { 
      id: "147677741369", 
      name: "Xtreme Wairau", 
      types: ["Shipper"], 
      skus: [...hide_bag, ...hide_packet, ...hide_shipper] // Xtreme hides bags/packets/shippers
    },
    { 
      id: "147677315385", 
      name: "Night N Day", 
      types: ["Shipper"], 
      skus: [] // Retail sees everything except bulk shippers
    }
  ];

  for (const cat of catalogs) {
    await prisma.catalogRule.upsert({
      where: { catalogId: cat.id },
      update: { hiddenVariantIds: cat.skus, hiddenVariantTypes: cat.types },
      create: { catalogId: cat.id, catalogName: cat.name, hiddenVariantIds: cat.skus, hiddenVariantTypes: cat.types }
    });
    console.log(`Synced ${cat.name}: ${cat.skus.length} SKU exceptions.`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());