// app/routes/api.send-phase3-b2b-access-emails.jsx
//
// Phase 3 (Night n Day) B2B access email catch-up. Phase 3 went live 7 Sept
// 2026 without the access email campaign ever running — see BUG-068 in the
// launch tracker and the notes in ../lib/phase3-access-emails.server.js.
//
// Unlike the Phase 1 and Phase 2 endpoints this has no go-live time gate,
// because the launch has already happened. Instead it will not send anything
// unless the caller passes { confirm: true }, so a stray or scheduled call can
// never fire it by accident. Default behaviour with no body is a dry run.
//
// Auth: same x-cron-secret header as the Phase 1/2 endpoints.
//
//   dry run:  { }                or { "dryRun": true }
//   send:     { "confirm": true }
//
// Idempotent: recipients who already have a "B2B access email" event on their
// Shopify customer timeline are skipped, so re-running is safe and manual sends
// made from Shopify Admin are respected.

import { unauthenticated } from "../shopify.server";
import { selectPhase3Recipients, tagPhase3Recipients, SHOP } from "../lib/phase3-access-emails.server";

export async function action({ request }) {
  const cronSecret = process.env.B2B_EMAIL_CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  if (!cronSecret || incomingSecret !== cronSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const confirm = body.confirm === true;

  const { default: prisma } = await import("../db.server");

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(SHOP));
  } catch (err) {
    console.error("[send-phase3-b2b-access-emails] failed to get admin client:", err);
    return Response.json({ error: "Failed to get admin client: " + err.message }, { status: 500 });
  }

  let selection;
  try {
    selection = await selectPhase3Recipients(admin, prisma);
  } catch (err) {
    console.error("[send-phase3-b2b-access-emails] selection failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }

  const summary = {
    totalOnCatalog: selection.totalOnCatalog,
    excludedStaff: selection.excludedStaff.length,
    missingEmail: selection.missingEmail.length,
    alreadySent: selection.alreadySent.length,
    pending: selection.recipients.length,
  };

  if (!confirm) {
    return Response.json({
      status: "dry-run",
      now: new Date().toISOString(),
      ...summary,
      recipients: selection.recipients.map((r) => ({ company: r.companyName, email: r.email })),
      excludedStaffDetail: selection.excludedStaff.map((r) => ({ company: r.companyName, email: r.email })),
      missingEmailDetail: selection.missingEmail.map((r) => ({ company: r.companyName, contactId: r.companyContactId })),
    });
  }

  const result = await tagPhase3Recipients(admin, prisma, selection.recipients);

  return Response.json({
    status: "tagged",
    now: new Date().toISOString(),
    ...summary,
    taggedThisRun: result.tagged,
    failedThisRun: result.failed,
    failures: result.failures,
  });
}
