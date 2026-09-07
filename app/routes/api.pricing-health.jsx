// app/routes/api.pricing-health.jsx
//
// Manual / external trigger for the pricing pair check. The same check also
// runs on a timer inside the web service (see lib/pricing-health.server.js), so
// this endpoint is for on-demand verification and for an external scheduler if
// one is ever preferred over the in-process timer.
//
//   GET /api/pricing-health?secret=<CRON_SECRET>          check and self-heal
//   GET /api/pricing-health?secret=<...>&heal=0           report only
//
// Also accepts the secret via the x-cron-secret header, matching the other
// cron-triggered routes in this app.

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export async function loader({ request }) {
  const url = new URL(request.url);
  const provided = request.headers.get("x-cron-secret") || url.searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET || "";

  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: HEADERS });
  }

  const heal = url.searchParams.get("heal") !== "0";

  try {
    const { checkAndHealPricing, runPricingHealthCheck } = await import("../lib/pricing-health.server");
    // heal=0 inspects quietly; otherwise go through the alerting path so a
    // repair or a problem still emails someone.
    const result = heal ? await runPricingHealthCheck("http") : await checkAndHealPricing({ heal: false });
    return new Response(JSON.stringify(result, null, 2), {
      status: result.healthy === false && result.problems?.length ? 503 : 200,
      headers: HEADERS,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 500, headers: HEADERS });
  }
}
