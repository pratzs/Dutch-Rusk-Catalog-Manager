import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { default: prisma } = await import("../db.server");
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const reps = await prisma.salesRep.findMany({
    where: { shop },
    orderBy: { name: "asc" },
  });

  return { reps };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { default: prisma } = await import("../db.server");
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "add" || intent === "update") {
    const repCode = String(form.get("repCode") || "").trim();
    const name = String(form.get("name") || "").trim();
    const email = String(form.get("email") || "").trim();
    if (!repCode || !name || !email) {
      return { error: "Rep code, name, and email are all required." };
    }
    try {
      await prisma.salesRep.upsert({
        where: { shop_repCode: { shop, repCode } },
        update: { name, email },
        create: { shop, repCode, name, email },
      });
      return { ok: `Saved ${name}.` };
    } catch (e) {
      return { error: e.message || "Could not save that sales rep." };
    }
  }

  if (intent === "toggle_active") {
    const id = String(form.get("id") || "");
    const active = form.get("active") === "true";
    await prisma.salesRep.update({ where: { id }, data: { active } });
    return { ok: active ? "Re-enabled." : "Disabled." };
  }

  if (intent === "delete") {
    const id = String(form.get("id") || "");
    await prisma.salesRep.delete({ where: { id } });
    return { ok: "Removed." };
  }

  return { error: "Unknown action." };
}

export default function SalesReps() {
  const { reps } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  const [form, setForm] = useState({ repCode: "", name: "", email: "" });

  const submitAdd = () => {
    if (!form.repCode || !form.name || !form.email) return;
    const fd = new FormData();
    fd.set("intent", "add");
    fd.set("repCode", form.repCode);
    fd.set("name", form.name);
    fd.set("email", form.email);
    fetcher.submit(fd, { method: "post" });
    setForm({ repCode: "", name: "", email: "" });
  };

  return (
    <s-page heading="Sales Reps" back-action-url="/app">
      <s-section heading="How this works">
        <s-text>
          Add a sales rep here for every <b>sales rep code</b> that will appear in a customer&apos;s{" "}
          <code>custom.sales_reps</code> metafield (synced from Ostendo). When one of that rep&apos;s
          customers places an order, they get an email with the order details automatically.
        </s-text>
      </s-section>

      <s-section heading="Add a sales rep">
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={labelStyle} htmlFor="rep-code-input">Rep code</label>
            <input
              id="rep-code-input"
              style={inputStyle}
              value={form.repCode}
              onChange={(e) => setForm((f) => ({ ...f, repCode: e.target.value }))}
              placeholder="e.g. 12"
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="rep-name-input">Name</label>
            <input
              id="rep-name-input"
              style={inputStyle}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Jane Smith"
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="rep-email-input">Email</label>
            <input
              id="rep-email-input"
              style={inputStyle}
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="jane@dutchrusk.co.nz"
            />
          </div>
          <s-button variant="primary" disabled={busy || undefined} onClick={submitAdd}>
            Add / Update
          </s-button>
        </div>
        {fetcher.data?.error ? (
          <s-text tone="critical" style={{ marginTop: "8px" }}>{fetcher.data.error}</s-text>
        ) : null}
        {fetcher.data?.ok ? (
          <s-text tone="success" style={{ marginTop: "8px" }}>{fetcher.data.ok}</s-text>
        ) : null}
        <s-text tone="subdued" style={{ marginTop: "8px" }}>
          Adding a rep code that already exists updates that rep&apos;s name/email instead of creating a duplicate.
        </s-text>
      </s-section>

      <s-section heading={`Sales reps (${reps.length})`}>
        {reps.length === 0 ? (
          <s-text tone="subdued">No sales reps added yet.</s-text>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f6f6f7", textAlign: "left", fontSize: 12 }}>
                <th style={cellHead}>Rep code</th>
                <th style={cellHead}>Name</th>
                <th style={cellHead}>Email</th>
                <th style={cellHead}>Status</th>
                <th style={cellHead}></th>
              </tr>
            </thead>
            <tbody>
              {reps.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb", fontSize: 13 }}>
                  <td style={cell}><strong>{r.repCode}</strong></td>
                  <td style={cell}>{r.name}</td>
                  <td style={cell}>{r.email}</td>
                  <td style={cell}>
                    <span style={statusBadge(r.active)}>{r.active ? "active" : "disabled"}</span>
                  </td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggle_active" />
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="active" value={(!r.active).toString()} />
                        <s-button size="slim" variant="secondary" type="submit">
                          {r.active ? "Disable" : "Enable"}
                        </s-button>
                      </fetcher.Form>
                      <fetcher.Form
                        method="post"
                        onSubmit={(e) => {
                          if (!window.confirm(`Remove ${r.name} (${r.repCode})?`)) e.preventDefault();
                        }}
                      >
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={r.id} />
                        <s-button size="slim" variant="secondary" tone="critical" type="submit">
                          Remove
                        </s-button>
                      </fetcher.Form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4, color: "#6d7175" };
const inputStyle = { padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 6, fontSize: 14 };
const cellHead = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid #e5e7eb" };
const cell = { padding: "8px 10px" };
function statusBadge(active) {
  const base = { padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 };
  return active ? { ...base, background: "#dcfce7", color: "#166534" } : { ...base, background: "#fee2e2", color: "#991b1b" };
}
