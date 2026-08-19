import { useState } from "react";
import { Form, useActionData, useNavigation } from "react-router";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  await authenticate.admin(request);
  return {};
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { parseCsv, resolveAll, persistResolved } = await import("../lib/csv-importer.server");
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const contentType = request.headers.get("content-type") || "";
  let mode, csvText, resultsJson;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    mode = String(form.get("mode") || "resolve");
    if (mode === "resolve") {
      const file = form.get("csv");
      if (!file || typeof file === "string") return { error: "No file uploaded." };
      csvText = await file.text();
    } else if (mode === "persist") {
      resultsJson = String(form.get("results") || "");
    }
  } else {
    const form = await request.formData();
    mode = String(form.get("mode") || "resolve");
    csvText = String(form.get("csvText") || "");
    resultsJson = String(form.get("results") || "");
  }

  if (mode === "resolve") {
    if (!csvText) return { error: "No CSV data." };
    const { rows, skippedBlankGroup, parseErrors } = parseCsv(csvText);
    if (rows.length === 0) return { error: "No usable rows found in CSV." };
    // For safety in Phase 1: cap at 1000 rows per import to avoid runaway GraphQL bills.
    const capped = rows.slice(0, 1000);
    const results = await resolveAll(shop, capped);
    const buckets = {
      matched: results.filter((r) => r?.status === "matched").length,
      matched_partial: results.filter((r) => r?.status === "matched_partial").length,
      no_customer: results.filter((r) => r?.status === "no_customer").length,
      no_location_match: results.filter((r) => r?.status === "no_location_match").length,
      ambiguous_location: results.filter((r) => r?.status === "ambiguous_location").length,
      error: results.filter((r) => r?.status === "error").length,
    };
    return {
      phase: "review",
      skippedBlankGroup: skippedBlankGroup.length,
      cappedTo1000: rows.length > 1000,
      totalUsable: rows.length,
      resolvedCount: results.length,
      buckets,
      results,
      parseErrors: parseErrors.length,
    };
  }

  if (mode === "persist") {
    let results;
    try { results = JSON.parse(resultsJson); } catch { return { error: "Invalid results payload." }; }
    const summary = await persistResolved(shop, results);
    return { phase: "done", summary };
  }

  return { error: "Unknown mode." };
}

export default function ImportCsv() {
  const actionData = useActionData();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [showAllFailures, setShowAllFailures] = useState(false);

  if (actionData?.phase === "done") {
    const s = actionData.summary;
    return (
      <s-page heading="Import complete" back-action-url="/app/customers">
        <s-section>
          <s-text><strong>{s.matched}</strong> customers imported. ({s.inserted} new, {s.updated} updated)</s-text>
          <s-text tone="subdued">Total processed: {s.total}</s-text>
          <s-button href="/app/customers">Back to customers</s-button>
        </s-section>
      </s-page>
    );
  }

  if (actionData?.phase === "review") {
    const { buckets, results, skippedBlankGroup, cappedTo1000 } = actionData;
    const failures = results.filter((r) => r && r.status !== "matched" && r.status !== "matched_partial");
    const shown = showAllFailures ? failures : failures.slice(0, 30);
    return (
      <s-page heading="Review CSV import" back-action-url="/app/customers/import">
        <s-section heading="Resolution report">
          <s-stack direction="inline" gap="base">
            <s-badge tone="success">Matched: {buckets.matched}</s-badge>
            <s-badge tone="info">Partial match: {buckets.matched_partial}</s-badge>
            <s-badge tone="critical">No customer: {buckets.no_customer}</s-badge>
            <s-badge tone="critical">No location match: {buckets.no_location_match}</s-badge>
            <s-badge tone="critical">Ambiguous: {buckets.ambiguous_location}</s-badge>
            <s-badge tone="critical">Errors: {buckets.error}</s-badge>
          </s-stack>
          {skippedBlankGroup > 0 ? (
            <s-text tone="subdued">Skipped {skippedBlankGroup} row(s) with blank customer_id / customer_name.</s-text>
          ) : null}
          {cappedTo1000 ? (
            <s-text tone="critical">CSV had more than 1000 usable rows; only the first 1000 were resolved this run.</s-text>
          ) : null}
        </s-section>

        {failures.length > 0 ? (
          <s-section heading={`Rows that could not be matched (${failures.length})`}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f6f6f7" }}>
                  <th style={cellHead}>Username</th>
                  <th style={cellHead}>Email</th>
                  <th style={cellHead}>Store name (from CSV)</th>
                  <th style={cellHead}>Group</th>
                  <th style={cellHead}>Why</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={cell}>{r.row.username}</td>
                    <td style={cell}>{r.row.email}</td>
                    <td style={cell}>{r.row.storeDisplayName}</td>
                    <td style={cell}>{r.row.catalogGroup}</td>
                    <td style={cell}><span style={badge(r.status)}>{r.status}</span> {r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {failures.length > 30 && !showAllFailures ? (
              <s-button variant="secondary" onClick={() => setShowAllFailures(true)}>Show all {failures.length}</s-button>
            ) : null}
          </s-section>
        ) : null}

        <s-section heading="Confirm import">
          <s-text>
            {buckets.matched + buckets.matched_partial} row(s) will be inserted or updated in the B2BUser table with <strong>status = invited</strong>. No emails will be sent by this action — send invites from the Customers page after import.
          </s-text>
          <Form method="post">
            <input type="hidden" name="mode" value="persist" />
            <input type="hidden" name="results" value={JSON.stringify(results)} />
            <s-button variant="primary" disabled={busy} submit>Import {buckets.matched + buckets.matched_partial} customer(s)</s-button>
          </Form>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Import customers from CSV" back-action-url="/app/customers">
      <s-section heading="Upload the Django export CSV">
        <s-text>
          Expected columns: <code>id, username, email, first_name, last_name, is_active, is_staff, is_superuser, date_joined, last_login, customer_id, customer_name</code>.<br />
          Rows with blank <code>customer_id</code> are skipped. Each row is resolved against Shopify (Customer by email, CompanyLocation by first_name) and only rows that match end up in the B2BUser table.
        </s-text>
        {actionData?.error ? (
          <s-box padding="base" background="critical-subdued" borderRadius="base">
            <s-text tone="critical">{actionData.error}</s-text>
          </s-box>
        ) : null}
        <Form method="post" encType="multipart/form-data">
          <input type="hidden" name="mode" value="resolve" />
          <input type="file" name="csv" accept=".csv" required style={{ display: "block", margin: "12px 0" }} />
          <s-button variant="primary" disabled={busy} submit>{busy ? "Resolving against Shopify…" : "Resolve customers"}</s-button>
        </Form>
      </s-section>
    </s-page>
  );
}

const cellHead = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid #e5e7eb", textAlign: "left" };
const cell = { padding: "8px 10px" };
function badge(status) {
  const base = { padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#fef3c7", color: "#92400e" };
  if (status === "matched" || status === "matched_partial") return { ...base, background: "#dcfce7", color: "#166534" };
  if (status === "no_customer" || status === "no_location_match" || status === "ambiguous_location" || status === "error") return { ...base, background: "#fee2e2", color: "#991b1b" };
  return base;
}
