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

  const allVariantIds = [...new Set(bundles.flatMap((b) => b.variantIds ?? []))];
  const variantsById = {};
  if (allVariantIds.length) {
    const variantsRes = await admin.graphql(
      `query BogoVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            image { url(transform: {maxWidth: 64, maxHeight: 64}) }
            product { title featuredImage { url(transform: {maxWidth: 64, maxHeight: 64}) } }
          }
        }
      }`,
      { variables: { ids: allVariantIds } }
    );
    const { data: variantsData } = await variantsRes.json();
    for (const node of variantsData?.nodes ?? []) {
      if (!node) continue;
      variantsById[node.id] = {
        id: node.id,
        productTitle: node.product?.title ?? "(unknown product)",
        variantTitle: node.title,
        imageUrl: node.image?.url ?? node.product?.featuredImage?.url ?? null,
      };
    }
  }

  const bundlesWithVariants = bundles.map((b) => ({
    ...b,
    variants: (b.variantIds ?? []).map((id) => variantsById[id] ?? { id, productTitle: "(product not found)", variantTitle: "", imageUrl: null }),
  }));

  const catalogsRes = await admin.graphql(
    `query BogoCatalogs {
      catalogs(first: 50) {
        nodes {
          id
          title
          ... on CompanyLocationCatalog { priceList { id } }
        }
      }
    }`
  );
  const { data: catalogsData } = await catalogsRes.json();
  const catalogs = (catalogsData?.catalogs?.nodes ?? [])
    .filter((c) => c.priceList?.id)
    .map((c) => ({ priceListId: c.priceList.id, title: c.title }));

  return { shopId, bundles: bundlesWithVariants, catalogs };
}

async function findPricingDiscountId(admin) {
  const res = await admin.graphql(
    `query { discountNodes(first: 50) { nodes { id discount { __typename ... on DiscountAutomaticApp { title } } } } }`
  );
  const { data } = await res.json();
  const node = data?.discountNodes?.nodes?.find(
    (n) => n.discount?.__typename === "DiscountAutomaticApp" && n.discount.title === "B2B Wholesale Custom Pricing"
  );
  return node?.id ?? null;
}

async function saveBundles(admin, shopId, bundles) {
  const metafields = [
    {
      ownerId: shopId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(bundles),
    },
  ];

  // The Function reading BOGO deals at checkout is merged into the
  // "B2B Wholesale Custom Pricing" discount and reads its config from
  // discountNode.metafield, not shop.metafield (the latter isn't resolved
  // at runtime for this deprecated Product Discount API target -- confirmed
  // by extensive testing). Write to both: shop for the theme's badge
  // Liquid, and the live discount for the Function itself.
  const pricingDiscountId = await findPricingDiscountId(admin);
  if (pricingDiscountId) {
    metafields.push({
      ownerId: pricingDiscountId,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(bundles),
    });
  }

  const res = await admin.graphql(
    `mutation SetBogoBundles($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    { variables: { metafields } }
  );
  const { data } = await res.json();
  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join(", "));
  if (!pricingDiscountId) throw new Error("Saved to the theme badge metafield, but couldn't find the live pricing discount to update -- checkout won't reflect this change until that's fixed.");
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
      const overridePctRaw = String(form.get("overridePct") || "").trim();
      const overridePct = overridePctRaw ? Number(overridePctRaw) : null;
      let variantIds = [];
      try {
        variantIds = JSON.parse(String(form.get("variantIds") || "[]"));
      } catch {
        variantIds = [];
      }
      let catalogIds = [];
      try {
        catalogIds = JSON.parse(String(form.get("catalogIds") || "[]"));
      } catch {
        catalogIds = [];
      }

      if (!id || !label) return { error: "Give the bundle an ID and a label." };
      if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0) return { error: "Buy and get quantities must be positive numbers." };
      if (!variantIds.length) return { error: "Select at least one product variant for this bundle." };
      if (overridePct !== null && (isNaN(overridePct) || overridePct <= 0 || overridePct >= 100)) {
        return { error: "Override discount % must be a number between 0 and 100 (or left blank)." };
      }

      const next = bundles.filter((b) => b.id !== id);
      const entry = { id, label, buyQty, getQty, variantIds };
      if (overridePct !== null) entry.overridePct = overridePct;
      if (catalogIds.length) entry.catalogIds = catalogIds;
      next.push(entry);
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

const emptyForm = { id: "", label: "", buyQty: "", getQty: "", overridePct: "", items: [], catalogIds: [] };

export default function Bogo() {
  const { bundles, catalogs } = useLoaderData();
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
    });
    if (!selection) return;

    const picked = [];
    for (const item of selection) {
      if (item.variants && item.variants.length) {
        for (const v of item.variants) {
          picked.push({ id: v.id, label: `${item.title} - ${v.title}`, imageUrl: v.image?.originalSrc ?? item.images?.[0]?.originalSrc ?? null });
        }
      } else {
        picked.push({ id: item.id, label: item.title, imageUrl: item.images?.[0]?.originalSrc ?? null });
      }
    }

    // Additive: merge newly picked items into the existing list rather than
    // replacing it, so re-opening the picker doesn't wipe out prior selections.
    setForm((f) => {
      const existingIds = new Set(f.items.map((it) => it.id));
      const merged = [...f.items, ...picked.filter((it) => !existingIds.has(it.id))];
      return { ...f, items: merged };
    });
  };

  const removeItem = (id) => {
    setForm((f) => ({ ...f, items: f.items.filter((it) => it.id !== id) }));
  };

  const toggleCatalog = (priceListId) => {
    setForm((f) => {
      const has = f.catalogIds.includes(priceListId);
      return { ...f, catalogIds: has ? f.catalogIds.filter((id) => id !== priceListId) : [...f.catalogIds, priceListId] };
    });
  };

  const startEdit = (bundle) => {
    setEditingId(bundle.id);
    setForm({
      id: bundle.id,
      label: bundle.label,
      buyQty: String(bundle.buyQty),
      getQty: String(bundle.getQty),
      overridePct: bundle.overridePct != null ? String(bundle.overridePct) : "",
      items: bundle.variants.map((v) => ({
        id: v.id,
        label: v.variantTitle ? `${v.productTitle} - ${v.variantTitle}` : v.productTitle,
        imageUrl: v.imageUrl,
      })),
      catalogIds: bundle.catalogIds ?? [],
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
    if (!form.label || !form.buyQty || !form.getQty || !form.items.length) return;
    const fd = new FormData();
    fd.set("intent", "save_bundle");
    fd.set("id", form.id);
    fd.set("label", form.label);
    fd.set("buyQty", form.buyQty);
    fd.set("getQty", form.getQty);
    fd.set("overridePct", form.overridePct);
    fd.set("variantIds", JSON.stringify(form.items.map((it) => it.id)));
    fd.set("catalogIds", JSON.stringify(form.catalogIds));
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
          These are the live Buy-X-Get-Y deals on the storefront, applied automatically at checkout alongside
          wholesale pricing. &quot;Buy 10 Get 1 Free&quot; means the 11th item is free, ten paid plus one free.
          Add, edit, or remove a deal here each month, no developer involvement needed. Changes take effect
          immediately, and matching products automatically get a badge on collection and product pages.
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
                  <td style={cell}>
                    Buy {b.buyQty}, get {b.getQty} free
                    {b.overridePct != null ? (
                      <div style={{ color: "#6d7175", fontSize: 12, marginTop: 2 }}>
                        + {b.overridePct}% off (instead of catalog price) on other units
                      </div>
                    ) : null}
                    <div style={{ color: "#6d7175", fontSize: 12, marginTop: 2 }}>
                      {b.catalogIds?.length
                        ? `Only: ${b.catalogIds.map((id) => catalogs.find((c) => c.priceListId === id)?.title ?? id).join(", ")}`
                        : "All catalogs"}
                    </div>
                  </td>
                  <td style={cell}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: 160, overflowY: "auto", minWidth: 220 }}>
                      {b.variants.map((v) => (
                        <div key={v.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          {v.imageUrl ? (
                            <img src={v.imageUrl} alt="" width={28} height={28} style={{ objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                          ) : (
                            <div style={{ width: 28, height: 28, borderRadius: 4, background: "#f1f2f3", flexShrink: 0 }} />
                          )}
                          <span style={{ fontSize: 12 }}>
                            {v.productTitle}{v.variantTitle ? ` - ${v.variantTitle}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </td>
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
              <label style={labelStyle} htmlFor="override-input">Override discount % (optional)</label>
              <input
                id="override-input"
                type="number"
                min="0"
                max="99"
                style={inputStyle}
                value={form.overridePct}
                onChange={(e) => setForm((f) => ({ ...f, overridePct: e.target.value }))}
                placeholder="Leave blank to keep each customer's normal catalog price"
              />
              <s-text tone="subdued" style={{ fontSize: 12, marginTop: 4 }}>
                For units beyond the deal, e.g. Dragon bags normally get 20% off catalog price. Set this to
                10 to run &quot;10% off + Buy 5 Get 1 Free&quot; instead of the usual 20%. Leave blank to keep
                the normal catalog discount for everything except the free unit.
              </s-text>
            </div>
            <div>
              <label style={labelStyle}>Which catalogs get this deal?</label>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: 180, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px" }}>
                {catalogs.map((c) => (
                  <label key={c.priceListId} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={form.catalogIds.includes(c.priceListId)}
                      onChange={() => toggleCatalog(c.priceListId)}
                    />
                    {c.title}
                  </label>
                ))}
              </div>
              <s-text tone="subdued" style={{ fontSize: 12, marginTop: 4 }}>
                Leave everything unchecked to run this deal for every B2B customer. Check specific catalogs (e.g.
                &quot;General Catalog&quot;) to limit it to just those customers, like this month&apos;s General
                Catalog-only deals.
              </s-text>
            </div>
            <div>
              <label style={labelStyle}>Products in this deal ({form.items.length})</label>
              {form.items.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: 260, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px", marginBottom: "8px" }}>
                  {form.items.map((it) => (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      {it.imageUrl ? (
                        <img src={it.imageUrl} alt="" width={28} height={28} style={{ objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                      ) : (
                        <div style={{ width: 28, height: 28, borderRadius: 4, background: "#f1f2f3", flexShrink: 0 }} />
                      )}
                      <span style={{ fontSize: 12, flex: 1 }}>{it.label}</span>
                      <button
                        type="button"
                        onClick={() => removeItem(it.id)}
                        aria-label={`Remove ${it.label}`}
                        style={{ border: "none", background: "none", color: "#8c1a10", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 4px" }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <s-text tone="subdued">No products selected yet.</s-text>
              )}
              <s-button variant="secondary" onClick={pickProducts}>Add products / variants</s-button>
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
