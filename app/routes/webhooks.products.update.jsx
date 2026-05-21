// app/routes/webhooks.products.update.jsx
//
// Fires whenever a product is updated in Shopify — including when Ostendo
// syncs new pricing. When base prices change, the catalog discount % still
// applies correctly (the Function reads it from company metafields), BUT
// any fixed-price overrides stored in the variant metafield need to be
// re-checked in case the catalog now has a different fixed price for this product.
//
// We trigger a targeted re-sync of just the affected product's variants.
//
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, admin, session, payload } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE") {
    return new Response("OK", { status: 200 });
  }

  try {
    const product = payload;
    const variantIds = (product.variants ?? [])
      .filter((v) => v.id)
      .map((v) => `gid://shopify/ProductVariant/${v.id}`);

    if (variantIds.length === 0) {
      return new Response("OK", { status: 200 });
    }

    console.log(`[products/update] Re-syncing ${variantIds.length} variant(s) for product ${product.id} (${product.title})`);

    // Delegate to the catalog price sync with targeted variant list
    const shop = session?.shop;
    const cronSecret = process.env.CRON_SECRET ?? "internal";

    // Self-call the sync endpoint with targeted variant IDs
    const syncUrl = `${process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com"}/api/catalog-price-sync`;
    const res = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": cronSecret,
      },
      body: JSON.stringify({ variantIds }),
    });

    const data = await res.json();
    console.log(`[products/update] Sync result for product ${product.id}:`, JSON.stringify(data));
  } catch (err) {
    console.error("[products/update] Error:", err);
    // Still return 200 so Shopify doesn't retry
  }

  return new Response("OK", { status: 200 });
};
