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
  const { session, admin } = await authenticate.admin(request);
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

  if (intent === "send_test") {
    const testEmail = String(form.get("testEmail") || "").trim();
    if (!testEmail) return { error: "Enter an email address to send the test to." };

    try {
      // Pull your actual most recent order so the test uses real product
      // names, real customer/company, and real prices -- not made-up data.
      const res = await admin.graphql(
        `query LatestOrder {
          orders(first: 1, sortKey: CREATED_AT, reverse: true) {
            nodes {
              id
              name
              customer { firstName lastName email }
              lineItems(first: 20) {
                nodes {
                  title
                  sku
                  quantity
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  image { url }
                }
              }
              subtotalPriceSet { shopMoney { amount currencyCode } }
              purchasingEntity {
                ... on PurchasingCompany { company { name } }
              }
            }
          }
        }`
      );
      const { data } = await res.json();
      const order = data?.orders?.nodes?.[0];
      if (!order) return { error: "Couldn't find any orders on this store to use as a test." };

      const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ") || order.customer?.email || "Customer";
      const companyName = order.purchasingEntity?.company?.name || customerName;
      const numericOrderId = order.id.split("/").pop();
      const shopHandle = shop.replace(".myshopify.com", "");
      const currency = order.subtotalPriceSet?.shopMoney?.currencyCode || "NZD";

      const { sendSalesRepOrderNotification } = await import("../lib/brevo.server");
      await sendSalesRepOrderNotification({
        repEmail: testEmail,
        repName: "there",
        orderName: order.name,
        orderUrl: `https://admin.shopify.com/store/${shopHandle}/orders/${numericOrderId}`,
        customerName,
        companyName,
        lineItems: order.lineItems.nodes.map((li) => ({
          title: li.title,
          sku: li.sku,
          quantity: li.quantity,
          price: li.originalUnitPriceSet?.shopMoney?.amount,
          imageUrl: li.image?.url || null,
        })),
        subtotal: order.subtotalPriceSet?.shopMoney?.amount,
        currency,
      });
      return { ok: `Sent. Used your real order ${order.name} (${companyName}) as the test data, check ${testEmail}.` };
    } catch (e) {
      return { error: `Send failed: ${e.message || e}` };
    }
  }

  return { error: "Unknown action." };
}

export default function SalesReps() {
  const { reps } = useLoaderData();
  const fetcher = useFetcher();
  const testFetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const testBusy = testFetcher.state !== "idle";

  const [form, setForm] = useState({ repCode: "", name: "", email: "" });
  const [testEmail, setTestEmail] = useState("");

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

  const submitTest = () => {
    if (!testEmail) return;
    const fd = new FormData();
    fd.set("intent", "send_test");
    fd.set("testEmail", testEmail);
    testFetcher.submit(fd, { method: "post" });
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

      <s-section heading="Send a test email">
        <s-text tone="subdued">
          Grabs your most recent real order and sends it to an address of your choosing, so you can check
          exactly what a sales rep will actually receive.
        </s-text>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end", marginTop: "10px" }}>
          <div>
            <label style={labelStyle} htmlFor="test-email-input">Send test to</label>
            <input
              id="test-email-input"
              style={inputStyle}
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="you@worthy.nz"
            />
          </div>
          <s-button variant="secondary" disabled={testBusy || undefined} onClick={submitTest}>
            {testBusy ? "Sending…" : "Send test email"}
          </s-button>
        </div>
        {testFetcher.data?.error ? (
          <s-text tone="critical" style={{ marginTop: "8px" }}>{testFetcher.data.error}</s-text>
        ) : null}
        {testFetcher.data?.ok ? (
          <s-text tone="success" style={{ marginTop: "8px" }}>{testFetcher.data.ok}</s-text>
        ) : null}
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
