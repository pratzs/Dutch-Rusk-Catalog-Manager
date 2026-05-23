// app/routes/webhooks.catalogs.jsx
// Handles CATALOGS_CREATE, CATALOGS_UPDATE, CATALOGS_DELETE.
// Triggers an immediate sync for the specific catalog's price list.

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { topic, payload, shop } = await authenticate.webhook(request);

  console.log(`[webhooks/catalogs] Received ${topic} for ${shop}`);

  if (topic === "CATALOGS_DELETE") {
      return new Response("OK", { status: 200 });
  }

  try {
    const cronSecret = process.env.CRON_SECRET ?? "internal";
    const syncUrl = `${process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com"}/api/catalog-price-sync`;

    // The catalog payload in 2026-04 includes the price_list_id if applicable
    const priceListId = payload.price_list_id;

    if (priceListId) {
        const fullPriceListId = `gid://shopify/PriceList/${priceListId}`;
        console.log(`[webhooks/catalogs] Triggering targeted sync for PriceList: ${fullPriceListId}`);

        const res = await fetch(syncUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-cron-secret": cronSecret,
            },
            body: JSON.stringify({ priceListIds: [fullPriceListId] }),
        });

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data = await res.json();
            console.log(`[webhooks/catalogs] Sync result:`, JSON.stringify(data));
        }
    } else {
        console.log(`[webhooks/catalogs] No price_list_id in payload, triggering full sync fallback.`);
        await fetch(syncUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-cron-secret": cronSecret },
            body: JSON.stringify({ forceAll: false }),
        });
    }
  } catch (err) {
    console.error("[webhooks/catalogs] Error:", err);
  }

  return new Response("OK", { status: 200 });
};
