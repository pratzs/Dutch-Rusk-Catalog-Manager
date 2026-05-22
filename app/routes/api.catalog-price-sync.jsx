// app/routes/api.catalog-price-sync.jsx

const BATCH = 25;

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
    // Small delay to avoid hitting rate limits in high-volume situations
    if (metafields.length > BATCH) await new Promise(r => setTimeout(r, 100));
  }
}

async function fetchAllPriceLists(admin) {
  const lists = [];
  let cursor = null;
  const log = (...args) => console.log("[catalog-sync]", ...args);
  do {
    const { data } = await gql(admin, `query GetPriceLists($cursor: String) { priceLists(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id name updatedAt parent { adjustment { type value } } } } }`, { cursor });
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
  console.log(`[catalog-sync] Finished. Total prices in list: ${prices.length}`);
  return prices;
}

async function fetchCatalogCompanyMap(admin) {
  const result = [];
  let cursor = null;
  do {
    const { data } = await gql(admin, `query GetCatalogs($cursor: String) { catalogs(first: 20, after: $cursor, type: COMPANY_LOCATION) { pageInfo { hasNextPage endCursor } nodes { priceList { id } ... on CompanyLocationCatalog { companyLocations(first: 100) { nodes { company { id } } } } } } }`, { cursor });
    const page = data?.catalogs;
    if (!page) break;
    for (const cat of page.nodes) {
      if (!cat.priceList?.id) continue;
      const companyIds = [...new Set((cat.companyLocations?.nodes ?? []).map((loc) => loc.company?.id).filter(Boolean))];
      result.push({ priceListId: cat.priceList.id, companyIds });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return result;
}

async function fetchVariantFixedPriceMeta(admin, variantIds) {
  const map = {};
  for (let i = 0; i < variantIds.length; i += 50) {
    const batch = variantIds.slice(i, i + 50);
    const { data } = await gql(admin, `query GetVariantMeta($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice meta: metafield(namespace: "custom", key: "catalog_fixed_prices") { value } } } }`, { ids: batch });
    for (const node of data?.nodes ?? []) { if (node?.id) { map[node.id] = { metaValue: node.meta?.value ?? null, price: node.price, compareAtPrice: node.compareAtPrice }; } }
  }
  return map;
}

async function runSync(admin, shop, options = {}) {
  const { forceAll = false, variantIds: specificVariantIds = null, companyOnly = false } = options;
  const log = (...args) => console.log("[catalog-sync]", ...args);
  const { default: prisma } = await import("../db.server");

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

  // ── 1. Variant Metafields Sync ───────────────────────────────────────────
  let updatedVariants = 0;
  if (!companyOnly) {
    const toSync = forceAll ? priceLists : priceLists.filter((pl) => {
      const db = dbMap[pl.id];
      if (!db) return true;
      const adj = allAdjustments[pl.id];
      return db.adjustmentType !== adj.type || db.adjustmentValue !== adj.value || db.shopifyUpdatedAt !== pl.updatedAt;
    });

    log(`${toSync.length} price list(s) need exhaustive variant sync`);

    for (const pl of toSync) {
      const prices = await fetchPriceListPrices(admin, pl.id);
      for (const { variantId, price } of prices) { allOverridesByList[pl.id][variantId] = price; }
    }

    const affectedVariantIds = new Set();
    for (const pl of toSync) {
      for (const id of Object.keys(allOverridesByList[pl.id] ?? {})) affectedVariantIds.add(id);
    }
    if (specificVariantIds) { for (const id of specificVariantIds) affectedVariantIds.add(id); }

    if (affectedVariantIds.size > 0) {
      log(`Updating ${affectedVariantIds.size} variant(s)...`);
      const variantIdArray = [...affectedVariantIds];
      const existingMeta = await fetchVariantFixedPriceMeta(admin, variantIdArray);
      const metafieldsToWrite = [];
      for (const variantId of variantIdArray) {
        const vData = existingMeta[variantId];
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
      updatedVariants = metafieldsToWrite.length;
    }

    // Persist list states
    for (const pl of toSync) {
      const adj = allAdjustments[pl.id];
      await prisma.catalogSyncState.upsert({
        where: { shop_priceListId: { shop, priceListId: pl.id } },
        create: { 
          shop, 
          priceListId: pl.id, 
          priceListName: pl.name, 
          shopifyUpdatedAt: pl.updatedAt,
          adjustmentType: adj?.type ?? "", 
          adjustmentValue: adj?.value ?? 0, 
          overriddenVariantIds: JSON.stringify([...new Set(Object.keys(allOverridesByList[pl.id] ?? {}))]) 
        },
        update: { 
          priceListName: pl.name, 
          shopifyUpdatedAt: pl.updatedAt,
          adjustmentType: adj?.type ?? "", 
          adjustmentValue: adj?.value ?? 0, 
          overriddenVariantIds: JSON.stringify([...new Set(Object.keys(allOverridesByList[pl.id] ?? {}))]) 
        },
      });
    }
  }

  // ── 2. Company Metafields Sync ───────────────────────────────────────────
  log("Updating company mapping...");
  const catalogCompanyMap = await fetchCatalogCompanyMap(admin);
  const companyMetafields = [];
  let updatedCompanies = 0;
  for (const { priceListId, companyIds } of catalogCompanyMap) {
    const adj = allAdjustments[priceListId];
    if (!adj) continue;
    const pct = adj.type === "PERCENTAGE_DECREASE" ? String(adj.value) : adj.type === "PERCENTAGE_INCREASE" ? String(-adj.value) : "0";
    for (const companyId of companyIds) {
      companyMetafields.push(
        { ownerId: companyId, namespace: "custom", key: "catalog_pricelist_id", type: "single_line_text_field", value: priceListId },
        { ownerId: companyId, namespace: "custom", key: "catalog_discount_pct", type: "number_decimal", value: pct }
      );
      updatedCompanies++;
    }
  }
  if (companyMetafields.length > 0) {
    await metafieldsSet(admin, companyMetafields);
  }

  log("Sync cycle complete.");
  return { success: true, updatedCompanies, updatedVariants };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const cronSecret = process.env.CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  const body = await request.json().catch(() => ({}));
  let admin, shop;
  if (incomingSecret && incomingSecret === cronSecret) {
    const { default: prisma } = await import("../db.server");
    const session = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
    if (!session) return Response.json({ error: "No offline session found" }, { status: 500 });
    shop = session.shop;
    const token = session.accessToken;
    admin = { graphql: async (query, { variables } = {}) => { const r = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }) }); return { json: () => r.json() }; } };
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
