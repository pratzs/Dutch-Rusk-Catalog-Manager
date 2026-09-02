import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";

const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "bogo_bundles";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(
    `query BogoBundles {
      shop {
        id
        metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") { value }
      }
    }`
  );
  const { data } = await res.json();
  const shopId = data?.shop?.id;
  let bundles = [];
  try {
    bundles = JSON.parse(data?.shop?.metafield?.value || "[]");
  } catch {
    bundles = [];
  }

  return { shopId, bundles };
}

async function saveBundles(admin, shopId, bundles) {
  const res = await admin.graphql(
    `mutation SetBogoBundles($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(bundles),
          },
        ],
      },
    }
  );
  const { data } = await res.json();
  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join(", "));
}

async function readBundles(admin) {
  const res = await admin.graphql(
    `query BogoBundlesForWrite {
      shop { id metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") { value } }
    }`
  );
  const { data } = await res.json();
  const shopId = data?.shop?.id;
  let bundles = [];
  try {
    bundles = JSON.parse(data?.shop?.metafield?.value || "[]");
  } catch {
    bundles = [];
  }
  return { shopId, bundles };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    const { shopId, bundles } = await readBundles(admin);

    if (intent === "save_bundle") {
      const id = String(form.get("id") || "").trim();
      const label = String(form.get("label") || "").trim();
      const buyQty = Number(form.get("buyQty"));
      const getQty = Number(form.get("getQty"));
      let variantIds = [];
      try {
        variantIds = JSON.parse(String(form.get("variantIds") || "[]"));
      } catch {
        variantIds = [];
      }

      if (!id || !label) return { error: "Give the bundle an ID and a label." };
      if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0) return { error: "Buy and get quantities must be positive numbers." };
      if (!variantIds.length) return { error: "Select at least one product variant for this bundle." };

      const next = bundles.filter((b) => b.id !== id);
      next.push({ id, label, buyQty, getQty, variantIds });
      await saveBundles(admin, shopId, next);
      return { ok: `Saved "${label}".` };
    }

    if (intent === "delete_bundle") {
      const id = String(form.get("id") || "");
      const next = bundles.filter((b) => b.id !== id);
      await saveBundles(admin, shopId, next);
      return { ok: "Deal removed." };
    }

    return { error: "Unknown action." };
  } catch (e) {
    return { error: e.message || "Something went wrong." };
  }
}

const emptyForm = { id: "", label: "", buyQty: "", getQty: "", variantIds: [], variantLabels: [] };

export default function Bogo() {
  const { bundles } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);

  const pickProducts = async () => {
    if (!window.shopify?.resourcePicker) {
      window.alert("Product picker isn't available in this context. Try reloading the app inside Shopify Admin.");
      return;
    }
    const selection = await window.shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { variants: true },
      selectionIds: form.variantIds.map((id) => ({ id })),
    });
    if (!selection) return;

    const variantIds = [];
    const variantLabels = [];
    for (const item of selection) {
      if (item.variants && item.variants.length) {
        for (const v of item.variants) {
          variantIds.push(v.id);
          variantLabels.push(`${item.title} - ${v.title}`);
        }
      } else {
        variantIds.push(item.id);
        variantLabels.push(item.title);
      }
    }
    setForm((f) => ({ ...f, variantIds, variantLabels }));
  };

  const startEdit = (bundle) => {
    setEditingId(bundle.id);
    setForm({
      id: bundle.id,
      label: bundle.label,
      buyQty: String(bundle.buyQty),
      getQty: String(bundle.getQty),
      variantIds: bundle.variantIds,
      variantLabels: [`${bundle.variantIds.length} variant(s) currently selected — use "Choose products" to change`],
    });
  };

  const startNew = () => {
    setEditingId("new");
    setForm({ ...emptyForm, id: `bundle-${Date.now()}` });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const submitSave = () => {
    if (!form.label || !form.buyQty || !form.getQty || !form.variantIds.length) return;
    const fd = new FormData();
    fd.set("intent", "save_bundle");
    fd.set("id", form.id);
    fd.set("label", form.label);
    fd.set("buyQty", form.buyQty);
    fd.set("getQty", form.getQty);
    fd.set("variantIds", JSON.stringify(form.variantIds));
    fetcher.submit(fd, { method: "post" });
    cancelEdit();
  };

  const submitDelete = (id) => {
    if (!window.confirm("Remove this deal?")) return;
    const fd = new FormData();
    fd.set("intent", "delete_bundle");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="BOGO Bundles" back-action-url="/app">
      <s-section heading="How this works">
        <s-text>
          These are the live Buy-X-Get-Y deals on the storefront, applied by the <b>BOGO Bundles</b> Shopify
          Function (no combining with other discounts). Add, edit, or remove a deal here each month — no
          developer involvement needed. Changes take effect immediately at checkout, and matching products
          automatically get a &quot;Buy X Get Y Free&quot; badge on collection and product pages.
        </s-text>
      </s-section>

      {fetcher.data?.error ? <s-section><s-text tone="critical">{fetcher.data.error}</s-text></s-section> : null}
      {fetcher.data?.ok ? <s-section><s-text tone="success">{fetcher.data.ok}</s-text></s-section> : null}

      <s-section heading={`Active deals (${bundles.length})`}>
        {bundles.length === 0 ? (
          <s-text tone="subdued">No BOGO deals yet.</s-text>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f6f6f7", textAlign: "left", fontSize: 12 }}>
                <th style={cellHead}>Deal</th>
                <th style={cellHead}>Terms</th>
                <th style={cellHead}>Products</th>
                <th style={cellHead}></th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((b) => (
                <tr key={b.id} style={{ borderTop: "1px solid #e5e7eb", fontSize: 13 }}>
                  <td style={cell}><strong>{b.label}</strong></td>
                  <td style={cell}>Buy {b.buyQty}, get {b.getQty} free</td>
                  <td style={cell}>{b.variantIds.length} variant(s)</td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <s-button size="slim" variant="secondary" onClick={() => startEdit(b)}>Edit</s-button>
                      <s-button size="slim" variant="secondary" tone="critical" disabled={busy || undefined} onClick={() => submitDelete(b.id)}>
                        Remove
                      </s-button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>

      <s-section heading={editingId ? (editingId === "new" ? "Add a new deal" : "Edit deal") : "Add a new deal"}>
        {!editingId ? (
          <s-button variant="primary" onClick={startNew}>Add a new deal</s-button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: 480 }}>
            <div>
              <label style={labelStyle} htmlFor="label-input">Deal name (shown as the badge text)</label>
              <input
                id="label-input"
                style={inputStyle}
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Buy 10 Get 1 Free"
              />
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <div>
                <label style={labelStyle} htmlFor="buy-input">Buy quantity</label>
                <input
                  id="buy-input"
                  type="number"
                  min="1"
                  style={inputStyle}
                  value={form.buyQty}
                  onChange={(e) => setForm((f) => ({ ...f, buyQty: e.target.value }))}
                />
              </div>
              <div>
                <label style={labelStyle} htmlFor="get-input">Get quantity free</label>
                <input
                  id="get-input"
                  type="number"
                  min="1"
                  style={inputStyle}
                  value={form.getQty}
                  onChange={(e) => setForm((f) => ({ ...f, getQty: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <s-button variant="secondary" onClick={pickProducts}>Choose products / variants</s-button>
              {form.variantLabels.length ? (
                <div style={{ marginTop: "8px", fontSize: 12, color: "#6d7175" }}>
                  {form.variantLabels.slice(0, 10).map((l, i) => <div key={i}>{l}</div>)}
                  {form.variantLabels.length > 10 ? <div>…and {form.variantLabels.length - 10} more</div> : null}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <s-button variant="primary" disabled={busy || undefined} onClick={submitSave}>Save deal</s-button>
              <s-button variant="secondary" onClick={cancelEdit}>Cancel</s-button>
            </div>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4, color: "#6d7175" };
const inputStyle = { padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 6, fontSize: 14, width: "100%" };
const cellHead = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid #e5e7eb" };
const cell = { padding: "8px 10px" };
