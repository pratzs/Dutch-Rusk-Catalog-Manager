import prisma from './app/db.server.js';

async function run() {
  console.log('--- STARTING OPTIMIZED OVERRIDE REPAIR ---');

  const blanketTypes = ["Shipper", "Bag"];
  const overrides = await prisma.productOverride.findMany();
  console.log(`Found ${overrides.length} total overrides.`);

  const updates = [];
  for (const override of overrides) {
    const currentHidden = override.hiddenVariantIds || [];
    if (currentHidden.includes("__SHOW_ALL__")) continue;

    const missing = blanketTypes.filter(t => !currentHidden.some(ch => ch.toLowerCase().includes(t.toLowerCase())));

    if (missing.length > 0) {
      const nextHidden = [...currentHidden, ...missing];
      updates.push(prisma.productOverride.update({
        where: { id: override.id },
        data: { hiddenVariantIds: nextHidden }
      }));
    }
  }

  console.log(`Processing ${updates.length} updates in batches...`);
  
  const BATCH_SIZE = 50;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      await Promise.all(updates.slice(i, i + BATCH_SIZE));
      console.log(`Progress: ${i + BATCH_SIZE} / ${updates.length}`);
  }

  console.log(`Successfully updated ${updates.length} overrides.`);
}

run();
