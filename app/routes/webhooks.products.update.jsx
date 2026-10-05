// app/routes/webhooks.products.update.jsx

const recentlySynced = new Map(); // productId (number) → timestamp ms
const DEDUP_TTL = 3 * 60 * 1000; // 3 minutes

// products/update arrives in bursts (a bulk edit, or the sync's own variant
// metafield writes, fires dozens in the same second). Each one used to POST its
// own full catalog sync, so a burst started many exhaustive syncs at once and
// the instance stopped answering: Shopify logged those deliveries as "no
// response" after its 5s timeout. Collect the variant ids instead and run ONE
// pass once the burst has been quiet for DEBOUNCE_MS.
const DEBOUNCE_MS = 20 * 1000;
const MAX_WAIT_MS = 2 * 60 * 1000; // a never-quiet stream still syncs this often
const pendingVariantIds = new Set();
let flushTimer = null;
let pendingSince = 0;

function flushPending() {
  flushTimer = null;
  pendingSince = 0;
  if (pendingVariantIds.size === 0) return;
  const variantIds = [...pendingVariantIds];
  pendingVariantIds.clear();

  const cronSecret = process.env.CRON_SECRET ?? "internal";
  const base = process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com";

  // /api/catalog-reprice first puts catalog prices and compare-at back in step
  // with the new retail, THEN runs the price sync that rebuilds the metafields.
  // The sync used to be called from here directly; run in parallel it read the
  // old prices, and its 8-minute lock refused the second run. The debounce
  // above stays: one call per burst. See docs/CATALOG-PRICING.md.
  fetch(`${base}/api/catalog-reprice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": cronSecret },
    body: JSON.stringify({ variantIds }),
  })
    .then((res) => res.json())
    .catch(() => {});
}

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

  // Don't sync inline — the sync takes far longer than Shopify's webhook
  // timeout. Acknowledge immediately; the debounced flush runs it later.
  for (const id of variantIds) pendingVariantIds.add(id);
  if (!pendingSince) pendingSince = now;
  if (flushTimer) clearTimeout(flushTimer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, pendingSince + MAX_WAIT_MS - now));
  flushTimer = setTimeout(flushPending, wait);

  return new Response("OK", { status: 200 });
};
