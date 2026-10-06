// app/routes/api.metromart-report.jsx
//
// Preview or test-send the Metromart North vs South report (Jira SUP-45).
// The real weekly / monthly sends run on a timer (lib/metromart-report.server.js).
//
//   GET /api/metromart-report?secret=<CRON_SECRET>&kind=week            HTML preview, nothing sent
//   GET /api/metromart-report?secret=<...>&kind=month&send=1&to=a@b.nz  send a test copy to that address
//
// `to` is required for a send, so a test can never fall through to the real
// recipient by accident.

export async function loader({ request }) {
  const url = new URL(request.url);
  const provided = request.headers.get("x-cron-secret") || url.searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const kind = url.searchParams.get("kind") === "month" ? "month" : "week";
  try {
    const lib = await import("../lib/metromart-report.server");
    if (url.searchParams.get("send") === "1") {
      const to = url.searchParams.get("to");
      if (!to) return new Response(JSON.stringify({ error: "to is required for a send" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const result = await lib.sendMetromartReport(kind, { to });
      return new Response(JSON.stringify({ sent: true, to, ...result }, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const data = await lib.buildMetromartData(kind);
    const { html } = lib.renderMetromartEmail(data);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
