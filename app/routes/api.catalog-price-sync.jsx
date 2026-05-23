// app/routes/api.catalog-price-sync.jsx

const BATCH = 25; // Shopify limit for metafieldsSet
const VARIANT_BATCH = 250; // How many variants to process in one memory cycle

async function gql(adminOrFetch, query, variables = {}) {
  const res = await adminOrFetch.graphql(query, { variables });
  return res.json();
}

async function metafieldsSet(adminOrFetch, metafields) {
  for (let i = 0; i < metafields.length; i += BATCH) {
    const batch = metafields.slice(i, i + BATCH);
    const result = await gql(adminOrFetch, `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message code } } }`, { metafields: batch });
    const errors = result?.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length > 0) console.error("[catalog-sync] metafieldsSet errors:", JSON.stringify(errors));
    if (metafields.length > BATCH) await new Promise(r => setTimeout(r, 50)); // Throttling
  }
}

async function fetchAllPriceLists(admin) {
  const lists = [];
  let cursor = null;
  do {
    const { data } = await gql(admin, `query GetPriceLists($cursor: String) { priceLists(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id name parent { adjustment { type value } } } } }`, { cursor });
    const page = data?.priceLists;
    if (!page) break;
    lists.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return lists;
}

async function fetchPriceListPrices(admin, priceListId) {
  const prices = [];
  let cursor = null;
  console.log(`[catalog-sync] Fetching all prices for price list: ${priceListId}`);
  do {
    const { data } = await gql(admin, `query GetPriceListPrices($id: ID!, $cursor: String) { priceList(id: $id) { prices(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { price { amount } variant { id } } } } }`, { id: priceListId, cursor });
    const page = data?.priceList?.prices;
    if (!page) break;
    for (const node of page.nodes) {
      if (node.variant?.id && node.price?.amount) prices.push({ variantId: node.variant.id, price: node.price.amount });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return prices;
}

async function fetchCatalogCompanyMap(admin) {
  // Returns: [{priceListId, catalogId, companyIds: [...], locationIds: [...]}]
  const result = [];
  let cursor = null;
  do {
    const { data } = await gql(admin, `query GetCatalogs($cursor: String) { catalogs(first: 20, after: $cursor, type: COMPANY_LOCATION) { pageInfo { hasNextPage endCursor } nodes { id priceList { id } ... on CompanyLocationCatalog { companyLocations(first: 100) { nodes { id company { id } } } } } } }`, { cursor });
    const page = data?.catalogs;
    if (!page) break;
    for (const cat of page.nodes) {
      if (!cat.priceList?.id) continue;
      const locations = cat.companyLocations?.nodes ?? [];
      const companyIds = [...new Set(locations.map((loc) => loc.company?.id).filter(Boolean))];
      const locationIds = locations.map(loc => loc.id).filter(Boolean);
      result.push({ 
        priceListId: cat.priceList.id, 
        catalogId: cat.id.split("/").pop(),
        companyIds,
        locationIds
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return result;
}

async function fetchVariantFixedPriceMetaBatch(admin, variantIds) {
  const map = {};
  const { data } = await gql(admin, `query GetVariantMeta($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice meta: metafield(namespace: "custom", key: "catalog_fixed_prices") { value } } } }`, { ids: variantIds });
  for (const node of data?.nodes ?? []) {
    if (node?.id) {
      map[node.id] = { metaValue: node.meta?.value ?? null, price: node.price, compareAtPrice: node.compareAtPrice };
    }
  }
  return map;
}

async function runSync(admin, shop, options = {}) {
  const { forceAll = false, variantIds: specificVariantIds = null, companyOnly = false } = options;
  const log = (...args) => console.log("[catalog-sync]", ...args);
  const { default: prisma } = await import("../db.server");

  // ── 0. Concurrency Lock ──────────────────────────────────────────────────
  const lockKey = "GLOBAL_SYNC_LOCK";
  const lastSync = await prisma.catalogSyncState.findFirst({ where: { shop, priceListId: lockKey } });
  const now = Date.now();
  if (lastSync && now - lastSync.lastSyncedAt.getTime() < 8 * 60 * 1000) {
    log("Sync already in progress (locked). Skipping.");
    return { success: false, message: "Locked" };
  }
  await prisma.catalogSyncState.upsert({ where: { shop_priceListId: { shop, priceListId: lockKey } }, create: { shop, priceListId: lockKey, lastSyncedAt: new Date() }, update: { lastSyncedAt: new Date() } });

  try {
    log(`Starting sync | CompanyOnly: ${companyOnly} | Force: ${forceAll}`);

    const priceLists = await fetchAllPriceLists(admin);
    const dbStates = await prisma.catalogSyncState.findMany({ where: { shop } });
    const dbMap = Object.fromEntries(dbStates.map((s) => [s.priceListId, s]));

    const allOverridesByList = {}; 
    const allAdjustments = {}; 

    for (const pl of priceLists) {
      const adj = pl.parent?.adjustment || { type: "PERCENTAGE_DECREASE", value: 0 };
      allAdjustments[pl.id] = adj;
      allOverridesByList[pl.id] = {};
    }

    let updatedVariants = 0;
    if (!companyOnly) {
      const toSync = forceAll ? priceLists : priceLists.filter((pl) => {
        const db = dbMap[pl.id];
        if (!db) return true;
        const adj = allAdjustments[pl.id];
        return db.adjustmentType !== adj.type || db.adjustmentValue !== adj.value;
      });

      if (toSync.length > 0 || specificVariantIds) {
        log(`Processing ${toSync.length} price list(s) for variants...`);
        for (const pl of toSync) {
          const prices = await fetchPriceListPrices(admin, pl.id);
          for (const { variantId, price } of prices) { allOverridesByList[pl.id][variantId] = price; }
        }
        const affectedVariantIds = new Set();
        for (const pl of toSync) { for (const id of Object.keys(allOverridesByList[pl.id] ?? {})) affectedVariantIds.add(id); }
        if (specificVariantIds) { for (const id of specificVariantIds) affectedVariantIds.add(id); }

        const variantIdArray = [...affectedVariantIds];
        log(`Iteratively updating ${variantIdArray.length} variant(s) in batches of ${VARIANT_BATCH}...`);
        for (let i = 0; i < variantIdArray.length; i += VARIANT_BATCH) {
          const batchIds = variantIdArray.slice(i, i + VARIANT_BATCH);
          const existingMetaBatch = await fetchVariantFixedPriceMetaBatch(admin, batchIds);
          const metafieldsToWrite = [];
          for (const variantId of batchIds) {
            const vData = existingMetaBatch[variantId];
            const standardPrice = vData?.compareAtPrice || vData?.price || "0";
            let merged = {};
            try { if (vData?.metaValue) merged = JSON.parse(vData.metaValue); } catch { merged = {}; }
            for (const pl of toSync) {
              const price = allOverridesByList[pl.id]?.[variantId];
              if (price !== undefined) merged[pl.id] = price; else delete merged[pl.id];
            }
            metafieldsToWrite.push(
              { ownerId: variantId, namespace: "custom", key: "catalog_fixed_prices", type: "json", value: JSON.stringify(merged) },
              { ownerId: variantId, namespace: "custom", key: "standard_retail_price", type: "number_decimal", value: String(standardPrice) }
            );
          }
          await metafieldsSet(admin, metafieldsToWrite);
          updatedVariants += metafieldsToWrite.length;
        }
        for (const pl of toSync) {
          const adj = allAdjustments[pl.id];
          await prisma.catalogSyncState.upsert({
            where: { shop_priceListId: { shop, priceListId: pl.id } },
            create: { shop, priceListId: pl.id, priceListName: pl.name, adjustmentType: adj?.type ?? "", adjustmentValue: adj?.value ?? 0 },
            update: { priceListName: pl.name, adjustmentType: adj?.type ?? "", adjustmentValue: adj?.value ?? 0 },
          });
        }
      }
    }

    log("Updating B2B mapping (Companies & Locations)...");
    const catalogDataMap = await fetchCatalogCompanyMap(admin);
    const companyMetafields = [];
    let updatedCompanies = 0;
    const locationUpserts = [];

    for (const { priceListId, catalogId, companyIds, locationIds } of catalogDataMap) {
      const adj = allAdjustments[priceListId];
      const pct = adj ? (adj.type === "PERCENTAGE_DECREASE" ? String(adj.value) : adj.type === "PERCENTAGE_INCREASE" ? String(-adj.value) : "0") : "0";

      for (const locId of locationIds) {
        locationUpserts.push(prisma.locationCatalogMap.upsert({
          where: { locationGid: locId },
          update: { catalogId },
          create: { locationGid: locId, catalogId },
        }));
      }

      for (const companyId of companyIds) {
        companyMetafields.push(
          { ownerId: companyId, namespace: "custom", key: "catalog_pricelist_id", type: "single_line_text_field", value: priceListId },
          { ownerId: companyId, namespace: "custom", key: "catalog_discount_pct", type: "number_decimal", value: pct }
        );
        updatedCompanies++;
      }
    }

    if (locationUpserts.length > 0) { log(`Updating ${locationUpserts.length} location mappings...`); await Promise.all(locationUpserts); }
    if (companyMetafields.length > 0) { log(`Updating ${updatedCompanies} company metafields...`); await metafieldsSet(admin, companyMetafields); }

    log("Sync cycle complete.");
    return { success: true, updatedCompanies, updatedVariants };

  } finally {
    await prisma.catalogSyncState.deleteMany({ where: { shop, priceListId: lockKey } });
  }
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const cronSecret = process.env.CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  const body = await request.json().catch(() => ({}));
  let admin, shop;

  if (incomingSecret && incomingSecret === cronSecret) {
    const { default: prisma } = await import("../db.server");
    const session = await prisma.session.findFirst({
      where: { isOnline: false, accessToken: { not: "" } },
      orderBy: { id: "desc" },
    });
    if (!session) {
      console.error("[catalog-sync] Error: No offline session found in DB");
      return Response.json({ error: "Configuration Error" }, { status: 500 });
    }
    shop = session.shop;
    const token = session.accessToken;
    admin = {
      graphql: async (query, { variables } = {}) => {
        const r = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query, variables }),
        });
        return { json: () => r.json() };
      },
    };
  } else {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
    shop = auth.session.shop;
  }

  try {
    const result = await runSync(admin, shop, { 
      forceAll: body.forceAll === true, 
      variantIds: Array.isArray(body.variantIds) ? body.variantIds : null,
      companyOnly: body.companyOnly === true
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    console.error("[catalog-sync] Error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
