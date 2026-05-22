// app/routes/webhooks.companies_sync.jsx
// Handles COMPANIES_CREATE, COMPANIES_UPDATE, 
// COMPANY_LOCATIONS_CREATE, COMPANY_LOCATIONS_UPDATE.
// Triggers a lightweight 'companyOnly' sync to ensure B2B account
// metafields are always current.

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { topic, session } = await authenticate.webhook(request);

  console.log(`[webhooks/companies_sync] Received ${topic} for ${session?.shop}`);

  try {
    const cronSecret = process.env.CRON_SECRET ?? "internal";
    const syncUrl = `${process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com"}/api/catalog-price-sync`;

    // Trigger a company-only sync (fast)
    const res = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": cronSecret,
      },
      body: JSON.stringify({ companyOnly: true }),
    });

    const data = await res.json();
    console.log(`[webhooks/companies_sync] Sync result:`, JSON.stringify(data));
  } catch (err) {
    console.error("[webhooks/companies_sync] Error:", err);
  }

  return new Response("OK", { status: 200 });
};
