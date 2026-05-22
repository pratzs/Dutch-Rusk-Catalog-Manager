// app/routes/api.catalog-price-sync.jsx
//
// Smart B2B catalog price sync.
// Reads every B2B price list from Shopify, detects changes (via updatedAt),
// and writes three metafields so the Shopify Function can apply correct
// per-line discounts at checkout:
//
//   company  → custom.catalog_pricelist_id   (which price list this company is on)
//   company  → custom.catalog_discount_pct   (blanket % e.g. "20")
//   variant  → custom.catalog_fixed_prices   (JSON of priceListGid→fixedPrice for overrides)
//   variant  → custom.standard_retail_price   (compareAtPrice or price)
//
// Called by:
//   • Dashboard "Sync Catalog Prices" button  (authenticate.admin)
//   • Render Cron Job every 10 min            (x-cron-secret header)
//   • webhooks.products.update                (after Ostendo updates a product price)
//
// POST body options:
//   {}                        → full change-detected sync (normal)
//   { variantIds: [...] }     → re-sync specific variants only (from products/update webhook)
//   { forceAll: true }        → re-sync every price list regardless of updatedAt
//

const BATCH = 25; // metafieldsSet accepts up to 25 per call

// ─── helpers ────────────────────────────────────────────────────────────────

async function gql(adminOrFetch, query, variables = {}) {
  const res = await adminOrFetch.graphql(query, { variables });
  return res.json();
}

async function metafieldsSet(adminOrFetch, metafields) {
  // Batch into groups of BATCH
  for (let i = 0; i < metafields.length; i += BATCH) {
    const batch = metafields.slice(i, i + BATCH);
    const result = await gql(
      adminOrFetch,
      `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message code }
        }
      }`,
      { metafields: batch }
    );
    const errors = result?.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length > 0) {
      console.error("[catalog-sync] metafieldsSet errors:", JSON.stringify(errors));
    }
  }
}

// ─── fetch all B2B price lists (paginated) ───────────────────────────────────

async function fetchAllPriceLists(admin) {
  const lists = [];
  let cursor = null;
  const log = (...args) => console.log("[catalog-sync]", ...args);

  do {
    const { data } = await gql(
      admin,
      `query GetPriceLists($cursor: String) {
        priceLists(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            name
            parent { adjustment { type value } }
          }
        }
      }`,
      { cursor }
    );
    const page = data?.priceLists;
    if (!page) break;
    for (const pl of page.nodes) {
      log(`Fetched List: ${pl.name} (${pl.id}) | Adj: ${pl.parent?.adjustment?.type} = ${pl.parent?.adjustment?.value}`);
      lists.push(pl);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return lists;
}

// ─── fetch all prices for one price list (paginated) ───────────────────────

async function fetchPriceListPrices(admin, priceListId) {
  const prices = []; // [{variantId, price}]
  let cursor = null;
  do {
    const { data } = await gql(
      admin,
      `query GetPriceListPrices($id: ID!, $cursor: String) {
        priceList(id: $id) {
          prices(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              price { amount }
              variant { id }
            }
          }
        }
      }`,
      { id: priceListId, cursor }
    );
    const page = data?.priceList?.prices;
    if (!page) break;
    for (const node of page.nodes) {
      if (node.variant?.id && node.price?.amount) {
        prices.push({
          variantId: node.variant.id,
          price: node.price.amount,
        });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return prices;
}

// ─── fetch catalog→company mapping (all B2B catalogs) ───────────────────────

async function fetchCatalogCompanyMap(admin) {
  // Returns: [{priceListId, companyIds: [...]}]
  const result = [];
  let cursor = null;
  do {
    const { data } = await gql(
      admin,
      `query GetCatalogs($cursor: String) {
        catalogs(first: 20, after: $cursor, type: COMPANY_LOCATION) {
          pageInfo { hasNextPage endCursor }
          nodes {
            priceList { id }
            ... on CompanyLocationCatalog {
              companyLocations(first: 100) {
                nodes { company { id } }
              }
            }
          }
        }
      }`,
      { cursor }
    );
    const page = data?.catalogs;
    if (!page) break;
    for (const cat of page.nodes) {
      if (!cat.priceList?.id) continue;
      const companyIds = [
        ...new Set(
          (cat.companyLocations?.nodes ?? [])
            .map((loc) => loc.company?.id)
            .filter(Boolean)
        ),
      ];
      result.push({ priceListId: cat.priceList.id, companyIds });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return result;
}

// ─── fetch current catalog_fixed_prices metafields for specific variants ─────

async function fetchVariantFixedPriceMeta(admin, variantIds) {
  // Returns map: variantId → { metaValue, price, compareAtPrice }
  const map = {};
  for (let i = 0; i < variantIds.length; i += 50) {
    const batch = variantIds.slice(i, i + 50);
    const { data } = await gql(
      admin,
      `query GetVariantMeta($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            price
            compareAtPrice
            meta: metafield(namespace: "custom", key: "catalog_fixed_prices") {
              value
            }
          }
        }
      }`,
      { ids: batch }
    );
    for (const node of data?.nodes ?? []) {
      if (node?.id) {
        map[node.id] = {
          metaValue: node.meta?.value ?? null,
          price: node.price,
          compareAtPrice: node.compareAtPrice,
        };
      }
    }
  }
  return map;
}

// ─── main sync function ──────────────────────────────────────────────────────

async function runSync(admin, shop, options = {}) {
  const { forceAll = false, variantIds: specificVariantIds = null } = options;
  const log = (...args) => console.log("[catalog-sync]", ...args);
  const { default: prisma } = await import("../db.server");

  // ── 1. Fetch all price lists ─────────────────────────────────────────────
  log("Fetching price lists...");
  const priceLists = await fetchAllPriceLists(admin);
  log(`Found ${priceLists.length} price list(s)`);

  if (priceLists.length === 0) {
    return { updatedPriceLists: 0, updatedCompanies: 0, updatedVariants: 0, message: "No B2B price lists found" };
  }

  // ── 2. Load DB state for change detection ────────────────────────────────
  const dbStates = await prisma.catalogSyncState.findMany({ where: { shop } });
  const dbMap = Object.fromEntries(dbStates.map((s) => [s.priceListId, s]));

  // ── 3. Determine which price lists need re-syncing ───────────────────────
  const toSync = forceAll
    ? priceLists
    : priceLists.filter((pl) => {
        const db = dbMap[pl.id];
        if (!db) return true; // never synced before
        const adjType = pl.parent?.adjustment?.type ?? "";
        const adjValue = pl.parent?.adjustment?.value ?? 0;
        return db.adjustmentType !== adjType || db.adjustmentValue !== adjValue;
      });

  log(`${toSync.length} price list(s) need syncing (${forceAll ? "forced" : "changed"})`);

  if (toSync.length === 0 && !specificVariantIds) {
    return { updatedPriceLists: 0, updatedCompanies: 0, updatedVariants: 0, message: "Nothing changed" };
  }

  // ── 4. Build complete picture of all price lists (overrides + adjustments) ─
  log("Fetching prices for synced price lists...");
  const allOverridesByList = {}; // priceListId → {variantId → price}
  const allAdjustments = {}; // priceListId → {type, value}

  for (const pl of priceLists) {
    const adj = pl.parent?.adjustment;
    allAdjustments[pl.id] = adj
      ? { type: adj.type, value: adj.value }
      : { type: "PERCENTAGE_DECREASE", value: 0 };
    allOverridesByList[pl.id] = {};
  }

  for (const pl of toSync) {
    log(`Fetching all prices for price list: ${pl.name}`);
    const prices = await fetchPriceListPrices(admin, pl.id);
    for (const { variantId, price } of prices) {
      allOverridesByList[pl.id][variantId] = price;
    }
  }

  // ── 5. Gather all variant IDs that need updates ──────────────────────────
  const affectedVariantIds = new Set();
  
  // Previous override sets from DB (to detect removals)
  const previousOverriddenByList = {}; // priceListId → Set<variantId>
  for (const db of dbStates) {
    try {
      const ids = JSON.parse(db.overriddenVariantIds);
      previousOverriddenByList[db.priceListId] = new Set(ids);
    } catch {
      previousOverriddenByList[db.priceListId] = new Set();
    }
  }

  for (const pl of toSync) {
    const current = new Set(Object.keys(allOverridesByList[pl.id] ?? {}));
    const previous = previousOverriddenByList[pl.id] ?? new Set();
    for (const id of current) affectedVariantIds.add(id);
    for (const id of previous) affectedVariantIds.add(id); 
  }

  if (specificVariantIds) {
    for (const id of specificVariantIds) affectedVariantIds.add(id);
  }

  log(`${affectedVariantIds.size} variant(s) need metafield updates`);

  // ── 6. Read and Write Metafields ─────────────────────────────────────────
  let updatedVariants = 0;
  if (affectedVariantIds.size > 0) {
    const variantIdArray = [...affectedVariantIds];
    const existingMeta = await fetchVariantFixedPriceMeta(admin, variantIdArray);

    const metafieldsToWrite = [];

    for (const variantId of variantIdArray) {
      const vData = existingMeta[variantId];
      const standardPrice = vData?.compareAtPrice || vData?.price || "0";

      let merged = {};
      try {
        if (vData?.metaValue) merged = JSON.parse(vData.metaValue);
      } catch {
        merged = {};
      }

      for (const pl of toSync) {
        const price = allOverridesByList[pl.id]?.[variantId];
        if (price !== undefined) {
          merged[pl.id] = price;
        } else {
          delete merged[pl.id];
        }
      }

      metafieldsToWrite.push(
        {
          ownerId: variantId,
          namespace: "custom",
          key: "catalog_fixed_prices",
          type: "json",
          value: JSON.stringify(merged),
        },
        {
          ownerId: variantId,
          namespace: "custom",
          key: "standard_retail_price",
          type: "number_decimal",
          value: String(standardPrice),
        }
      );
    }

    await metafieldsSet(admin, metafieldsToWrite);
    updatedVariants = metafieldsToWrite.length;
  }

  // ── 7. Update company metafields ─────────────────────────────────────────
  log("Fetching catalog→company mapping...");
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

  // ── 8. Persist sync state ────────────────────────────────────────────────
  for (const pl of toSync) {
    const adj = pl.parent?.adjustment;
    await prisma.catalogSyncState.upsert({
      where: { shop_priceListId: { shop, priceListId: pl.id } },
      create: {
        shop,
        priceListId: pl.id,
        priceListName: pl.name,
        adjustmentType: adj?.type ?? "",
        adjustmentValue: adj?.value ?? 0,
        overriddenVariantIds: JSON.stringify([...new Set(Object.keys(allOverridesByList[pl.id] ?? {}))]),
      },
      update: {
        priceListName: pl.name,
        adjustmentType: adj?.type ?? "",
        adjustmentValue: adj?.value ?? 0,
        overriddenVariantIds: JSON.stringify([...new Set(Object.keys(allOverridesByList[pl.id] ?? {}))]),
      },
    });
  }

  log(`Done. Updated ${toSync.length} price list(s), ${updatedCompanies} company metafield(s), ${updatedVariants} variant metafield(s)`);

  return { updatedPriceLists: toSync.length, updatedCompanies, updatedVariants, message: toSync.length === 0 ? "Nothing changed" : `Synced ${toSync.length} price list(s)` };
}

// ─── route handler ───────────────────────────────────────────────────────────

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  
  const cronSecret = process.env.CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  const body = await request.json().catch(() => ({}));

  let admin;
  let shop;

  if (incomingSecret && incomingSecret === cronSecret) {
    const { default: prisma } = await import("../db.server");
    const session = await prisma.session.findFirst({
      where: { isOnline: false, accessToken: { not: "" } },
      orderBy: { id: "desc" },
    });
    if (!session) return Response.json({ error: "No offline session found" }, { status: 500 });
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
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    console.error("[catalog-sync] Error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
