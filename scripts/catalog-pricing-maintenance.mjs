// Hourly job. Deals, BOGO and the Deals page need the hour; the full price sweep
// inside it runs once a day (03:xx NZ). Backstop for catalog pricing. Runs on a Render cron job.
//
// It does not do the work itself: it asks the web service to, because the web
// service already has the Shopify session, the database and the price sync.
// What the web service does for { mode: "maintenance" }:
//   1. puts back any monthly deal whose month has ended (the 1st, NZ time)
//   1b. switches BOGO deals on/off for the month, and sinks sold-out products on
//       the Deals page
//   2. sweeps every catalog price: reprices percentage prices after an Ostendo
//      retail change, refreshes compare-at, fixes stale product-level compare-at
//   3. if anything changed, runs the price sync so the pricing metafields follow
// The product-update webhook handles the same work the moment Ostendo changes a
// price; this catches a webhook that never arrived. See docs/CATALOG-PRICING.md.
//
// Logs a line the moment it starts and one at the end, because a Render cron
// reporting success has proved nothing before (see deal-entitlement.mjs).
console.log("[catalog-pricing] starting");

const base = process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com";
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("[catalog-pricing] CRON_SECRET is not set on this cron job");
  process.exit(1);
}

try {
  const started = Date.now();
  const res = await fetch(`${base}/api/catalog-reprice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": secret },
    body: JSON.stringify({ mode: "maintenance" }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!res.ok || !body.success) {
    console.error(`[catalog-pricing] FAILED after ${secs}s: HTTP ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`[catalog-pricing] done in ${secs}s: checked ${body.checked}, updated ${body.updated}, held ${body.held}, product compare-at fixed ${body.variantCompareAtFixed}, deals reverted ${JSON.stringify(body.reverted)}, bogo ${JSON.stringify(body.bogo)}, sync triggered ${body.syncTriggered}`);
} catch (err) {
  console.error("[catalog-pricing] fatal:", err);
  process.exit(1);
}
