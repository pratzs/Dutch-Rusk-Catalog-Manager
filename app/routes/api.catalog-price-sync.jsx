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

/**
 * Turn { "gid://shopify/PriceList/34326708537": "12.34", ... } into
 * "|34326708537:12.34|...|", the form both pricing Functions read.
 *
 * Delimited on both ends so a lookup can search for "|<id>:" and never match
 * the tail of a longer id. A variant with no genuine discount on any catalog
 * gets a bare "|" rather than "", because Shopify rejects an empty metafield
 * value; both Functions read it as "no special price here", which is the same
 * thing they do for a variant that has no value at all.
 */
function buildCompactPrices(mapByPriceListGid) {
  const parts = [];
  for (const gid of Object.keys(mapByPriceListGid)) {
    parts.push(gid.slice(gid.lastIndexOf("/") + 1) + ":" + mapByPriceListGid[gid]);
  }
  return parts.length ? "|" + parts.join("|") + "|" : "|";
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

async function fetchExhaustiveB2BMap(admin) {
  const resultByCatalog = {};
  let cursor = null;
  console.log("[catalog-sync] Fetching exhaustive B2B Location structure...");
  do {
    const { data } = await gql(admin, `query GetB2BStructure($cursor: String) {
      companyLocations(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          company { id }
          catalogs(first: 5) {
            nodes {
              id
              priceList { id }
            }
          }
        }
      }
    }`, { cursor });
    const page = data?.companyLocations;
    if (!page) break;
    for (const loc of page.nodes) {
      for (const cat of loc.catalogs?.nodes ?? []) {
        if (!cat.priceList?.id) continue;
        const cId = cat.id;
        if (!resultByCatalog[cId]) {
          resultByCatalog[cId] = { catalogId: cId.split("/").pop(), priceListId: cat.priceList.id, companyIds: new Set(), locationIds: new Set() };
        }
        if (loc.company?.id) resultByCatalog[cId].companyIds.add(loc.company.id);
        resultByCatalog[cId].locationIds.add(loc.id);
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return Object.values(resultByCatalog).map(item => ({ ...item, companyIds: Array.from(item.companyIds), locationIds: Array.from(item.locationIds) }));
}

async function fetchVariantFixedPriceMetaBatch(admin, variantIds) {
  const map = {};
  const { data } = await gql(admin, `query GetVariantMeta($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice meta: metafield(namespace: "custom", key: "catalog_fixed_prices") { value } } } }`, { ids: variantIds });
  for (const node of data?.nodes ?? []) {
    if (node?.id) map[node.id] = { metaValue: node.meta?.value ?? null, price: node.price, compareAtPrice: node.compareAtPrice };
  }
  return map;
}

async function runSync(admin, shop, options = {}) {
  const { variantIds: specificVariantIds = null, companyOnly = false } = options;
  const log = (...args) => console.log("[catalog-sync]", ...args);
  const { default: prisma } = await import("../db.server");

  const lockKey = "GLOBAL_SYNC_LOCK";
  const lastSync = await prisma.catalogSyncState.findFirst({ where: { shop, priceListId: lockKey } });
  const now = Date.now();
  if (lastSync && now - lastSync.lastSyncedAt.getTime() < 8 * 60 * 1000) { log("Locked."); return { success: false, message: "Locked" }; }
  await prisma.catalogSyncState.upsert({ where: { shop_priceListId: { shop, priceListId: lockKey } }, create: { shop, priceListId: lockKey, lastSyncedAt: new Date() }, update: { lastSyncedAt: new Date() } });

  try {
    log(`Starting Pure Catalog Truth Sync | CompanyOnly: ${companyOnly}`);

    const priceLists = await fetchAllPriceLists(admin);
    const allOverridesByList = {}; 
    const allAdjustments = {}; 

    for (const pl of priceLists) {
      allAdjustments[pl.id] = pl.parent?.adjustment || { type: "PERCENTAGE_DECREASE", value: 0 };
      allOverridesByList[pl.id] = {};
    }

    let updatedVariants = 0;
    if (!companyOnly) {
      const toSync = priceLists; // Always sync for truth during rollout

      log(`Exhaustively syncing ${toSync.length} price list(s)`);
      for (const pl of toSync) {
        const prices = await fetchPriceListPrices(admin, pl.id);
        for (const { variantId, price } of prices) { allOverridesByList[pl.id][variantId] = price; }
      }

      const affectedVariantIds = new Set();
      for (const pl of toSync) { for (const id of Object.keys(allOverridesByList[pl.id] ?? {})) affectedVariantIds.add(id); }
      if (specificVariantIds) { for (const id of specificVariantIds) affectedVariantIds.add(id); }

      const variantIdArray = [...affectedVariantIds];
      log(`Updating ${variantIdArray.length} variants...`);

      for (let i = 0; i < variantIdArray.length; i += VARIANT_BATCH) {
        const batchIds = variantIdArray.slice(i, i + VARIANT_BATCH);
        const existingMetaBatch = await fetchVariantFixedPriceMetaBatch(admin, batchIds);
        const metafieldsToWrite = [];

        for (const variantId of batchIds) {
          const vData = existingMetaBatch[variantId];
          const standardPrice = parseFloat(vData?.compareAtPrice || vData?.price || "0");
          // Rebuilt from scratch each run rather than merged onto the previous
          // value, so entries for deleted price lists can't linger.
          const merged = {};

          for (const pl of toSync) {
            let price = allOverridesByList[pl.id]?.[variantId];
            
            // If Shopify didn't return an explicit price for this variant in the list,
            // we calculate the "Truth" by applying the catalog's percentage adjustment
            // to the standard retail price.
            if (price === undefined) {
                const adj = allAdjustments[pl.id];
                const retail = standardPrice;
                if (adj.type === "PERCENTAGE_DECREASE") {
                    price = (retail * (1 - adj.value / 100)).toFixed(2);
                } else if (adj.type === "PERCENTAGE_INCREASE") {
                    price = (retail * (1 + adj.value / 100)).toFixed(2);
                } else {
                    price = retail.toFixed(2);
                }
            }
            // Only keep entries that are a GENUINE discount against standard
            // retail. A price equal to (or above) retail means this catalog has
            // no special rate for the variant, and both Functions already treat
            // "absent" and "not a discount" identically -- the transformer only
            // raises when standardRetail > the catalog price, and the discount
            // only fires when it can go below the line price.
            //
            // This matters because the whole map is sent to those Functions on
            // EVERY cart line, and their input is capped. Storing all 12 price
            // lists per variant made large carts blow the cap: the transformer
            // would raise to retail while the discount Function silently failed,
            // and the customer paid full retail (orders #1409, #1850, #1884).
            // Pruning cuts the map from 12 entries to ~1.5 and the payload by
            // 87%, without changing a single price.
            if (parseFloat(price) < standardPrice - 0.005) {
              merged[pl.id] = price;
            }
          }

          // The same prices again, as the compact string both Functions
          // actually read: "|34326708537:12.34|34326872377:9.10|", keyed by the
          // numeric part of the price list id.
          //
          // Why a second copy rather than a format change: the Functions read
          // this on EVERY cart line and pay for every byte and every parse. The
          // JSON map costs a JSON.parse per line and carries the full
          // "gid://shopify/PriceList/" prefix on every entry; this costs one
          // indexOf and about half the bytes. catalog_fixed_prices is still
          // written because the (currently inert) b2b-catalog-discount function
          // reads it, and because keeping it means this sync can be rolled back
          // without a data migration.
          const compact = buildCompactPrices(merged);

          metafieldsToWrite.push(
            { ownerId: variantId, namespace: "custom", key: "catalog_fixed_prices", type: "json", value: JSON.stringify(merged) },
            { ownerId: variantId, namespace: "custom", key: "catalog_prices_v2", type: "single_line_text_field", value: compact },
            { ownerId: variantId, namespace: "custom", key: "standard_retail_price", type: "number_decimal", value: String(standardPrice) }
          );
        }
        await metafieldsSet(admin, metafieldsToWrite);
        updatedVariants += metafieldsToWrite.length;
      }
    }

    log("Updating mapping...");
    const catalogDataMap = await fetchExhaustiveB2BMap(admin);
    const companyMetafields = [];
    let updatedCompanies = 0;
    const locationUpserts = [];

    // A location can sit on more than one catalog, so collect the full set of
    // price lists per location before writing anything. Upserting inside the
    // catalog loop (as this used to) left whichever catalog came last, which is
    // arbitrary -- that is why Zone Bowling Henderson, on both TEEG and its own
    // list, resolved to the wrong one.
    const priceListsByLocation = new Map();

    for (const { priceListId, catalogId, companyIds, locationIds } of catalogDataMap) {
      for (const locId of locationIds) {
        let entry = priceListsByLocation.get(locId);
        if (!entry) {
          entry = { catalogId, priceListIds: [] };
          priceListsByLocation.set(locId, entry);
        }
        // catalogId deliberately keeps its old last-one-wins behaviour: the
        // variant-hiding rules keyed off it have been running on that value and
        // this change is only meant to add priceListIds, not move any buyer to
        // a different rule set.
        entry.catalogId = catalogId;
        if (!entry.priceListIds.includes(priceListId)) entry.priceListIds.push(priceListId);
      }
      for (const companyId of companyIds) {
        companyMetafields.push({ ownerId: companyId, namespace: "custom", key: "catalog_pricelist_id", type: "single_line_text_field", value: priceListId });
        updatedCompanies++;
      }
    }

    for (const [locationGid, { catalogId, priceListIds }] of priceListsByLocation) {
      const serialised = JSON.stringify(priceListIds);
      locationUpserts.push(prisma.locationCatalogMap.upsert({
        where: { locationGid },
        update: { catalogId, priceListIds: serialised },
        create: { locationGid, catalogId, priceListIds: serialised },
      }));
    }

    if (locationUpserts.length > 0) await Promise.all(locationUpserts);
    if (companyMetafields.length > 0) await metafieldsSet(admin, companyMetafields);

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
    // The offline token expires hourly, so it must be fetched through the
    // helper rather than read out of Prisma -- otherwise this runs fine by day
    // and fails every night. See app/lib/admin-token.server.js.
    const { getAdminToken } = await import("../lib/admin-token.server");
    let token;
    try {
      ({ shop, accessToken: token } = await getAdminToken());
    } catch (e) {
      return Response.json({ error: `No admin token: ${e.message}` }, { status: 500 });
    }
    admin = { graphql: async (query, { variables } = {}) => { const r = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }) }); return { json: () => r.json() }; } };
  } else {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
    shop = auth.session.shop;
  }
  try {
    return Response.json({ success: true, ...(await runSync(admin, shop, { forceAll: body.forceAll === true, variantIds: Array.isArray(body.variantIds) ? body.variantIds : null, companyOnly: body.companyOnly === true })) });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
