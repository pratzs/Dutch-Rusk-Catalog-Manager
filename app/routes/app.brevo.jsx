import { useLoaderData, useFetcher, Link } from "react-router";

const BRANDS = { dutchrusk: "Dutch Rusk", worthy: "Worthy Products" };

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const L = await import("../lib/brevo-contacts.server");
  const brand = new URL(request.url).searchParams.get("brand") === "worthy" ? "worthy" : "dutchrusk";
  const key = L.brevoKeyFor(brand);
  if (!key) return { brand, missingKey: true };
  const [brevo, lists] = await Promise.all([L.fetchBrevoContacts(key), L.fetchBrevoLists(key)]);
  // The Shopify side of the audit only applies to the store this app is installed on (Dutch Rusk).
  const shopify = brand === "dutchrusk" ? await L.fetchShopifyCustomers(admin) : [];
  const audit = L.buildAudit(brevo, shopify);
  const deadRe = /disregard|abandoned_checkouts|first list/i;
  return {
    brand,
    audit,
    shopifyChecked: brand === "dutchrusk",
    deadLists: lists.filter((l) => deadRe.test(l.name)).map((l) => ({ id: l.id, name: l.name })),
    listCount: lists.length,
  };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const L = await import("../lib/brevo-contacts.server");
  const form = await request.formData();
  const brand = form.get("brand") === "worthy" ? "worthy" : "dutchrusk";
  const key = L.brevoKeyFor(brand);
  if (!key || brand !== "dutchrusk") return { error: "Fixes run on Dutch Rusk only for now." };
  const intent = String(form.get("intent"));
  const [brevo, shopify] = await Promise.all([L.fetchBrevoContacts(key), L.fetchShopifyCustomers(admin)]);
  const audit = L.buildAudit(brevo, shopify);
  if (intent === "clear_defaults") {
    const r = await L.clearDefaultBlacklists(key, admin, audit.clearable);
    return { ok: `Cleared ${r.cleared}. Kept ${r.skipped.length} (real opt-out or changed). Failed ${r.failed.length}.` };
  }
  if (intent === "add_missing") {
    const missing = new Set(audit.missingInBrevo.map((m) => m.email.toLowerCase()));
    const subscribed = shopify.filter((c) => c.email && missing.has(c.email.toLowerCase()) && c.emailMarketingConsent?.marketingState === "SUBSCRIBED");
    const r = await L.createMissingContacts(key, subscribed, process.env.BREVO_MAIN_LIST_ID || 37);
    return { ok: `Added ${r.ok} subscribed customers to Brevo. Failed ${r.failed.length}.` };
  }
  return { error: "Unknown action." };
}

const card = { background: "#fff", border: "1px solid #e3e1dc", borderRadius: 10, padding: 16 };

function Stat({ label, value, note, tone }) {
  return (
    <div style={{ ...card, borderTop: `4px solid ${tone || "#FDB714"}` }}>
      <div style={{ fontSize: 12, color: "#66270F", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "#181344" }}>{value}</div>
      <div style={{ fontSize: 13, color: "#555" }}>{note}</div>
    </div>
  );
}

function Row({ title, count, body, action, fetcher, intent, brand, danger }) {
  return (
    <div style={{ ...card, display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
      <div>
        <strong style={{ color: "#181344" }}>{title}</strong>
        <span style={{ marginLeft: 8, background: danger ? "#fde8e4" : "#fff4d6", borderRadius: 12, padding: "2px 10px", fontWeight: 600 }}>{count}</span>
        <div style={{ fontSize: 13, color: "#555", marginTop: 4 }}>{body}</div>
      </div>
      {action && count > 0 && (
        <fetcher.Form method="post">
          <input type="hidden" name="brand" value={brand} />
          <input type="hidden" name="intent" value={intent} />
          <button type="submit" disabled={fetcher.state !== "idle"} style={{ background: "#181344", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", cursor: "pointer", whiteSpace: "nowrap" }}>
            {fetcher.state !== "idle" ? "Working..." : action}
          </button>
        </fetcher.Form>
      )}
    </div>
  );
}

export default function BrevoDashboard() {
  const d = useLoaderData();
  const fetcher = useFetcher();
  const tabs = Object.entries(BRANDS).map(([k, v]) => (
    <Link key={k} to={`?brand=${k}`} style={{ padding: "8px 16px", borderRadius: 20, textDecoration: "none", background: d.brand === k ? "#181344" : "#fff", color: d.brand === k ? "#fff" : "#181344", border: "1px solid #181344" }}>{v}</Link>
  ));
  return (
    <div style={{ padding: 20, background: "#FAF8F5", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ color: "#66270F", margin: "0 0 4px" }}>Brevo contacts</h1>
      <p style={{ margin: "0 0 14px", color: "#555" }}>Is Brevo in step with Shopify, and what needs a person to look at it.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>{tabs}</div>
      {d.missingKey ? (
        <div style={card}>No Brevo key is set for this brand yet. Add BREVO_API_KEY_WORTHY to the Render environment.</div>
      ) : (
        <>
          {fetcher.data?.ok && <div style={{ ...card, background: "#e8f5e9", marginBottom: 12 }}>{fetcher.data.ok}</div>}
          {fetcher.data?.error && <div style={{ ...card, background: "#fde8e4", marginBottom: 12 }}>{fetcher.data.error}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
            <Stat label="Brevo contacts" value={d.audit.totals.brevoEmail} note={`${d.audit.totals.brevoPhoneOnly} phone-only records mirror Shopify`} />
            {d.shopifyChecked && <Stat label="Shopify customers" value={d.audit.totals.shopify} note={`${d.audit.totals.shopifyNoEmail} have no email`} tone="#2156C3" />}
            <Stat label="Blacklisted in Brevo" value={d.audit.totals.blacklisted} note="Not the same as opted out" tone="#B13924" />
            <Stat label="Lists" value={d.listCount} note={`${d.deadLists.length} look dead`} tone="#F58220" />
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {d.shopifyChecked && (
              <>
                <Row title="Default blacklists" count={d.audit.clearable.length} body="Shopify says Not subscribed (the Ostendo push default). Clearing sets Shopify to Subscribed too, and skips anyone who clicked unsubscribe in Brevo." action="Clear and set subscribed" fetcher={fetcher} intent="clear_defaults" brand={d.brand} />
                <Row title="Real opt-outs" count={d.audit.realOptOut.length} body="Shopify says Unsubscribed. Never clear these." danger />
                <Row title="In Shopify, missing from Brevo" count={d.audit.missingInBrevo.length} body="Subscribed customers are added to the main list. Others are left out." action="Add subscribed ones" fetcher={fetcher} intent="add_missing" brand={d.brand} />
                <Row title="In Brevo, not in Shopify" count={d.audit.orphans.length} body="Old imports and stale contacts. Review before any campaign." />
                <Row title="Subscribed in Shopify, blacklisted in Brevo" count={d.audit.subscribedButBlacklisted.length} body="Out of step. Check the Brevo unsubscribe history first." danger />
              </>
            )}
            <Row title="Role addresses (info@, accounts@ ...)" count={d.audit.roleAddresses} body="Shared inboxes. Worth a named contact per customer." />
            <Row title="Contacts with no name" count={d.audit.noName} body="Emails start with a blank greeting." />
            <Row title="Dead lists" count={d.deadLists.length} body={d.deadLists.map((l) => l.name).join(", ") || "None"} />
          </div>
        </>
      )}
    </div>
  );
}
