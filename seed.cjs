const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const csv = require("csv-parser");

const prisma = new PrismaClient();

const CATALOG_MAPPING = {
  "alexander-marketing": "147677086009",
  "archie-brothers": "147677118777",
  "holey-moley": "147677184313",
  "kingpin-queenstown": "147677217081",
  "night-n-day": "147677315385",
  "teeg": "147677675833",
  "xtreme-wairau": "147677741369",
  "zone-bowling-henderson": "147677774137",
  "zone-bowling-manukau": "147677806905"
};

async function runSeed() {
  const rows = [];

  fs.createReadStream("products_export_1.csv")
    .pipe(csv())
    .on("data", (row) => rows.push(row))
    .on("end", async () => {
      console.log(`CSV Loaded: ${rows.length} rows found.`);
      
      const overrides = {}; 
      const ruleMap = [
        { tag: "hide-bag", keyword: "Bag", applyTo: ["teeg", "archie-brothers", "xtreme-wairau", "night-n-day", "holey-moley", "kingpin-queenstown", "alexander-marketing", "zone-bowling-manukau", "zone-bowling-henderson"] },
        { tag: "hide-block", keyword: "Block", applyTo: ["teeg"] },
        { tag: "hide-each", keyword: "Each", applyTo: ["teeg"] },
        { tag: "hide-packet", keyword: "Packet", applyTo: ["teeg", "archie-brothers", "kingpin-queenstown", "xtreme-wairau", "zone-bowling-manukau", "zone-bowling-henderson"] },
        { tag: "hide-shipper", keyword: "Shipper", applyTo: ["teeg", "archie-brothers", "kingpin-queenstown", "xtreme-wairau"] }
      ];

      let currentTags = "";
      let currentProductId = "";

      rows.forEach((row, index) => {
        // Find the columns regardless of exact header naming/spacing
        const rowKeys = Object.keys(row);
        const idKey = rowKeys.find(k => k.toLowerCase().trim() === 'id');
        const tagsKey = rowKeys.find(k => k.toLowerCase().trim() === 'tags');
        const vIdKey = rowKeys.find(k => k.toLowerCase().replace(/\s/g, '') === 'variantid');
        const opt1Key = rowKeys.find(k => k.toLowerCase().replace(/\s/g, '') === 'option1value');
        const opt2Key = rowKeys.find(k => k.toLowerCase().replace(/\s/g, '') === 'option2value');
        const opt3Key = rowKeys.find(k => k.toLowerCase().replace(/\s/g, '') === 'option3value');

        const rowId = row[idKey];
        const rowTags = row[tagsKey];

        if (rowId && rowId.trim() !== "") currentProductId = rowId.trim();
        if (rowTags && rowTags.trim() !== "") currentTags = rowTags.toLowerCase();

        if (!currentProductId || !row[vIdKey]) return;

        ruleMap.forEach(rule => {
          if (currentTags.includes(rule.tag)) {
            const val1 = (row[opt1Key] || "").toLowerCase();
            const val2 = (row[opt2Key] || "").toLowerCase();
            const val3 = (row[opt3Key] || "").toLowerCase();
            const k = rule.keyword.toLowerCase();

            if (val1.includes(k) || val2.includes(k) || val3.includes(k)) {
              const pGid = `gid://shopify/Product/${currentProductId}`;
              const vGid = `gid://shopify/ProductVariant/${row[vIdKey]}`;

              rule.applyTo.forEach(slug => {
                const catalogId = CATALOG_MAPPING[slug];
                const key = `${catalogId}_${pGid}`;
                if (!overrides[key]) {
                  overrides[key] = { catalogId, productId: pGid, hiddenVariantIds: [] };
                }
                if (!overrides[key].hiddenVariantIds.includes(vGid)) {
                  overrides[key].hiddenVariantIds.push(vGid);
                }
              });
            }
          }
        });
      });

      const finalData = Object.values(overrides);
      console.log(`Matched ${finalData.length} unique Catalog/Product override sets.`);

      if (finalData.length === 0) {
        console.log("❌ Error: Still 0 matches. Please verify that 'hide-bag' etc. actually exist in your Tags column.");
        process.exit();
      }

      try {
        await prisma.productOverride.deleteMany({});
        console.log(`Pushing to Render...`);
        for (let i = 0; i < finalData.length; i += 50) {
          const chunk = finalData.slice(i, i + 50);
          await prisma.productOverride.createMany({ data: chunk });
        }
        console.log("✅ Master Seed Complete!");
      } catch (e) {
        console.error("❌ DB Error:", e);
      } finally {
        await prisma.$disconnect();
      }
    });
}

runSeed();