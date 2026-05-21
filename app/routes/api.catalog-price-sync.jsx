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
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
  do {
    const { data } = await gql(
      admin,
      `query GetPriceLists($cursor: String) {
        priceLists(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            name
            updatedAt
            adjustment { type value }
          }
        }
      }`,
      { cursor }
    );
    const page = data?.priceLists;
    if (!page) break;
    lists.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return lists;
}

// ─── fetch fixed-price overrides for one price list (paginated) ──────────────

async function fetchPriceListOverrides(admin, priceListId) {
  const overrides = []; // [{variantId, fixedPrice}]
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
        overrides.push({
          variantId: node.variant.id,
          fixedPrice: node.price.amount,
        });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return overrides;
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
        catalogs(first: 20, after: $cursor, catalogType: B2B) {
          pageInfo { hasNextPage endCursor }
          nodes {
            priceList { id }
            ... on B2bCatalog {
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
  // Returns map: variantId → current JSON string (or null)
  const map = {};
  for (let i = 0; i < variantIds.length; i += 50) {
    const batch = variantIds.slice(i, i + 50);
    const { data } = await gql(
      admin,
      `query GetVariantMeta($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            meta: metafield(namespace: "custom", key: "catalog_fixed_prices") {
              value
            }
          }
        }
      }`,
      { ids: batch }
    );
    for (const node of data?.nodes ?? []) {
      if (node?.id) map[node.id] = node.meta?.value ?? null;
    }
  }
  return map;
}

// ─── main sync function ──────────────────────────────────────────────────────

async function runSync(admin, shop, options = {}) {
  const { forceAll = false, variantIds: specificVariantIds = null } = options;
  const log = (...args) => console.log("[catalog-sync]", ...args);

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
        return !db || db.shopifyUpdatedAt !== pl.updatedAt;
      });

  log(`${toSync.length} price list(s) need syncing (${forceAll ? "forced" : "changed"})`);

  if (toSync.length === 0 && !specificVariantIds) {
    return { updatedPriceLists: 0, updatedCompanies: 0, updatedVariants: 0, message: "Nothing changed" };
  }

  // ── 4. Build complete picture of all price lists (overrides + adjustments) ─
  // We need the full picture to merge catalog_fixed_prices correctly across catalogs
  log("Fetching overrides for all price lists...");
  const allOverridesByList = {}; // priceListId → {variantId → fixedPrice}
  const allAdjustments = {}; // priceListId → {type, value}

  for (const pl of priceLists) {
    const adj = pl.adjustment;
    allAdjustments[pl.id] = adj
      ? { type: adj.type, value: adj.value }
      : { type: "PERCENTAGE_DECREASE", value: 0 };
    allOverridesByList[pl.id] = {};
  }

  // Only fetch override details for changed lists (others keep DB state)
  for (const pl of toSync) {
    log(`Fetching overrides for price list: ${pl.name}`);
    const overrides = await fetchPriceListOverrides(admin, pl.id);
    for (const { variantId, fixedPrice } of overrides) {
      allOverridesByList[pl.id][variantId] = fixedPrice;
    }
    // Also load DB-cached overrides for UNCHANGED lists
    // (so we have a complete picture for merge step)
  }

  // For unchanged lists, use DB-stored override info
  for (const pl of priceLists) {
    if (toSync.some((s) => s.id === pl.id)) continue; // already fetched
    const db = dbMap[pl.id];
    if (!db) continue;
    // We don't cache override prices in DB — skip (they're unchanged anyway)
    // Just ensure the key exists
    if (!allOverridesByList[pl.id]) allOverridesByList[pl.id] = {};
  }

  // ── 5. Gather all variant IDs that currently or previously had overrides ──
  const currentOverriddenByList = {}; // priceListId → Set<variantId>
  for (const [plId, overrides] of Object.entries(allOverridesByList)) {
    currentOverriddenByList[plId] = new Set(Object.keys(overrides));
  }

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

  // Collect all affected variant IDs (new overrides + removed overrides)
  const affectedVariantIds = new Set();
  for (const pl of toSync) {
    const current = currentOverriddenByList[pl.id] ?? new Set();
    const previous = previousOverriddenByList[pl.id] ?? new Set();
    for (const id of current) affectedVariantIds.add(id);
    for (const id of previous) affectedVariantIds.add(id); // removed ones need clearing
  }

  // If called with specific variant IDs (from products/update webhook), add those
  if (specificVariantIds) {
    for (const id of specificVariantIds) affectedVariantIds.add(id);
  }

  log(`${affectedVariantIds.size} variant(s) need metafield updates`);

  // ── 6. Read current catalog_fixed_prices for affected variants ───────────
  let updatedVariants = 0;
  if (affectedVariantIds.size > 0) {
    const variantIdArray = [...affectedVariantIds];
    const existingMeta = await fetchVariantFixedPriceMeta(admin, variantIdArray);

    // Build the new merged JSON for each affected variant
    const metafieldsToWrite = [];

    for (const variantId of variantIdArray) {
      // Start from existing JSON (for price lists NOT being re-synced)
      let merged = {};
      try {
        if (existingMeta[variantId]) merged = JSON.parse(existingMeta[variantId]);
      } catch {
        merged = {};
      }

      // Apply updates from re-synced price lists
      for (const pl of toSync) {
        const fixedPrice = allOverridesByList[pl.id]?.[variantId];
        if (fixedPrice !== undefined) {
          merged[pl.id] = fixedPrice; // update/add fixed price
        } else {
          delete merged[pl.id]; // remove — this variant reverted to blanket %
        }
      }

      // If specific variant IDs were requested (products/update), also refresh from all lists
      if (specificVariantIds?.includes(variantId)) {
        for (const [plId, overrides] of Object.entries(allOverridesByList)) {
          const fixedPrice = overrides[variantId];
          if (fixedPrice !== undefined) {
            merged[plId] = fixedPrice;
          } else {
            delete merged[plId];
          }
        }
      }

      metafieldsToWrite.push({
        ownerId: variantId,
        namespace: "custom",
        key: "catalog_fixed_prices",
        type: "json",
        value: JSON.stringify(merged),
      });
    }

    await metafieldsSet(admin, metafieldsToWrite);
    updatedVariants = metafieldsToWrite.length;
  }

  // ── 7. Update company metafields (pricelist_id + discount_pct) ───────────
  log("Fetching catalog→company mapping...");
  const catalogCompanyMap = await fetchCatalogCompanyMap(admin);

  const companyMetafields = [];
  let updatedCompanies = 0;

  for (const { priceListId, companyIds } of catalogCompanyMap) {
    const adj = allAdjustments[priceListId];
    if (!adj) continue;

    const pct =
      adj.type === "PERCENTAGE_DECREASE"
        ? String(adj.value)
        : adj.type === "PERCENTAGE_INCREASE"
        ? String(-adj.value)
        : "0";

    for (const companyId of companyIds) {
      companyMetafields.push(
        {
          ownerId: companyId,
          namespace: "custom",
          key: "catalog_pricelist_id",
          type: "single_line_text_field",
          value: priceListId,
        },
        {
          ownerId: companyId,
          namespace: "custom",
          key: "catalog_discount_pct",
          type: "number_decimal",
          value: pct,
        }
      );
      updatedCompanies++;
    }
  }

  if (companyMetafields.length > 0) {
    await metafieldsSet(admin, companyMetafields);
  }

  // ── 8. Persist sync state to DB ──────────────────────────────────────────
  for (const pl of toSync) {
    const adj = pl.adjustment;
    await prisma.catalogSyncState.upsert({
      where: { shop_priceListId: { shop, priceListId: pl.id } },
      create: {
        shop,
        priceListId: pl.id,
        priceListName: pl.name,
        shopifyUpdatedAt: pl.updatedAt,
        adjustmentType: adj?.type ?? "",
        adjustmentValue: adj?.value ?? 0,
        overriddenVariantIds: JSON.stringify(
          [...(currentOverriddenByList[pl.id] ?? [])]
        ),
      },
      update: {
        priceListName: pl.name,
        shopifyUpdatedAt: pl.updatedAt,
        adjustmentType: adj?.type ?? "",
        adjustmentValue: adj?.value ?? 0,
        overriddenVariantIds: JSON.stringify(
          [...(currentOverriddenByList[pl.id] ?? [])]
        ),
      },
    });
  }

  log(`Done. Updated ${toSync.length} price list(s), ${updatedCompanies} company metafield(s), ${updatedVariants} variant metafield(s)`);

  return {
    updatedPriceLists: toSync.length,
    updatedCompanies,
    updatedVariants,
    message: toSync.length === 0 ? "Nothing changed" : `Synced ${toSync.length} price list(s)`,
  };
}

// ─── route handler ───────────────────────────────────────────────────────────

export async function action({ request }) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  const body = await request.json().catch(() => ({}));

  let admin;
  let shop;

  if (incomingSecret && incomingSecret === cronSecret) {
    // ── Cron / webhook call: authenticate using stored offline session ──────
    // Find the first available offline session (single-tenant app)
    const session = await prisma.session.findFirst({
      where: { isOnline: false, accessToken: { not: "" } },
      orderBy: { id: "desc" },
    });
    if (!session) {
      return Response.json({ error: "No offline session found — reinstall the app" }, { status: 500 });
    }
    shop = session.shop;

    // Build a minimal admin graphql shim using the raw access token
    const token = session.accessToken;
    const apiVersion = "2026-04";
    admin = {
      graphql: async (query, { variables } = {}) => {
        const r = await fetch(
          `https://${shop}/admin/api/${apiVersion}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({ query, variables }),
          }
        );
        return { json: () => r.json() };
      },
    };
  } else {
    // ── Admin dashboard call ─────────────────────────────────────────────
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
