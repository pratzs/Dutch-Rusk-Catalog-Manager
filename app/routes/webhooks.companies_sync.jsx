// app/routes/webhooks.companies_sync.jsx
// Handles COMPANIES_CREATE, COMPANIES_UPDATE, 
// COMPANY_LOCATIONS_CREATE, COMPANY_LOCATIONS_UPDATE.
// Triggers a lightweight 'companyOnly' sync to ensure B2B account
// metafields are always current.

// Keep track of the last time we triggered a sync to avoid storming
let lastTriggeredAt = 0;

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { topic, session } = await authenticate.webhook(request);

  console.log(`[webhooks/companies_sync] Received ${topic} for ${session?.shop}`);

  const now = Date.now();
  if (now - lastTriggeredAt < 10000) {
    console.log(`[webhooks/companies_sync] Recently triggered (last: ${now - lastTriggeredAt}ms ago). Skipping to avoid storm.`);
    return new Response("OK", { status: 200 });
  }
  lastTriggeredAt = now;

  const cronSecret = process.env.CRON_SECRET ?? "internal";
  const syncUrl = `${process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com"}/api/catalog-price-sync`;

  // Trigger a company-only sync WITHOUT awaiting it. The sync can take 20-30s
  // (11 price lists, sequential pagination) — Shopify's webhook delivery times
  // out around 5-6s, so awaiting it here was causing "no response" failures
  // on every slow run even though the sync itself completed fine. Acknowledge
  // Shopify immediately and let the sync run in the background instead.
  fetch(syncUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": cronSecret,
    },
    body: JSON.stringify({ companyOnly: true }),
  })
    .then(async (res) => {
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const text = await res.text();
        console.error(`[webhooks/companies_sync] Expected JSON but got ${contentType}. Body: ${text.substring(0, 200)}`);
        return;
      }
      const data = await res.json();
      console.log(`[webhooks/companies_sync] Sync result:`, JSON.stringify(data));
    })
    .catch((err) => {
      console.error("[webhooks/companies_sync] Error:", err);
    });

  return new Response("OK", { status: 200 });
};
