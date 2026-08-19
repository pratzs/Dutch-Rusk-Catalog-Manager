// app/routes/webhooks.products.update.jsx

const recentlySynced = new Map(); // productId (number) → timestamp ms
const DEDUP_TTL = 3 * 60 * 1000; // 3 minutes

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { topic, payload } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE") {
    return new Response("OK", { status: 200 });
  }

  const product = payload;
  const now = Date.now();
  for (const [id, ts] of recentlySynced) {
    if (now - ts > DEDUP_TTL) recentlySynced.delete(id);
  }
  if (recentlySynced.has(product.id)) {
    return new Response("OK", { status: 200 });
  }
  recentlySynced.set(product.id, now);

  const variantIds = (product.variants ?? []).filter((v) => v.id).map((v) => `gid://shopify/ProductVariant/${v.id}`);
  if (variantIds.length === 0) return new Response("OK", { status: 200 });

  const cronSecret = process.env.CRON_SECRET ?? "internal";
  const syncUrl = `${process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com"}/api/catalog-price-sync`;

  // Don't await — the sync can take longer than Shopify's webhook timeout.
  // Acknowledge immediately and let it run in the background.
  fetch(syncUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": cronSecret },
    body: JSON.stringify({ variantIds }),
  })
    .then((res) => res.json())
    .catch(() => {});

  return new Response("OK", { status: 200 });
};
