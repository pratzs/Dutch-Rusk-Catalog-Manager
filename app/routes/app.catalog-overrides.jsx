import { redirect } from "react-router";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const originalCatalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");
  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  if (!originalCatalogId) return redirect("/app/catalog-manager");

  const cleanId = originalCatalogId.includes("/") ? originalCatalogId.split("/").pop() : originalCatalogId;
  const paginationArgs = before ? `last: 50, before: "${before}"` : after ? `first: 50, after: "${after}"` : `first: 50`;

  let products = [];
  let pageInfo = { hasNextPage: false, hasPreviousPage: false };
  let debugMessage = "";

  let activeFullId = originalCatalogId.includes("gid://") ? originalCatalogId : `gid://shopify/Catalog/${cleanId}`;
  let pubId = null;

  async function getPubId(gid) {
    try {
      const response = await admin.graphql(
        `query getCat($id: ID!) {
          node(id: $id) {
            ... on Catalog { publication { id } }
            ... on MarketCatalog { publication { id } }
          }
        }`,
        { variables: { id: gid } }
      );
      const json = await response.json();
      if (json.errors) return null;
      return json.data?.node?.publication?.id || null;
    } catch (e) {
      return null;
    }
  }

  pubId = await getPubId(activeFullId);
  if (!pubId) {
    activeFullId = `gid://shopify/MarketCatalog/${cleanId}`;
    pubId = await getPubId(activeFullId);
  }

  if (pubId) {
    try {
      const prodResponse = await admin.graphql(
        `query getPubProducts($pubId: ID!) {
          publication(id: $pubId) {
            products(${paginationArgs}) {
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              nodes {
                id
                title
                variants(first: 250) { nodes { id title sku } }
              }
            }
          }
        }`,
        { variables: { pubId } }
      );
      const prodJson = await prodResponse.json();
      if (prodJson.errors) {
        debugMessage = "Products API Error: " + JSON.stringify(prodJson.errors);
      } else {
        products = prodJson.data?.publication?.products?.nodes || [];
        pageInfo = prodJson.data?.publication?.products?.pageInfo || pageInfo;
      }
    } catch (error) {
      debugMessage = "Product Fetch Catch: " + error.message;
    }
  } else {
    debugMessage = "Could not locate the Publication for this Catalog ID. Ensure products are assigned to this Market in Shopify Settings.";
  }

  const [overrides, rule] = await Promise.all([
    prisma.productOverride.findMany({ where: { catalogId: cleanId } }),
    prisma.catalogRule.findUnique({ where: { catalogId: cleanId } }),
  ]);

  const globalHiddenSkus = rule ? rule.hiddenVariantIds : [];
  const hiddenVariantTypes = rule ? rule.hiddenVariantTypes : [];
  const overridesMap = overrides.reduce((acc, o) => ({ ...acc, [o.productId]: o.hiddenVariantIds }), {});

  const allVariantTypes = new Set();
  products.forEach((p) => {
    p.variants.nodes.forEach((v) => {
      const match = v.title.match(/^([A-Za-z]+)/);
      if (match) allVariantTypes.add(match[1]);
    });
  });

  return {
    catalogDbId: cleanId,
    catalogGid: activeFullId,
    catalogName,
    products,
    overridesMap,
    globalHiddenSkus,
    hiddenVariantTypes,
    allVariantTypes: Array.from(allVariantTypes).sort(),
    pageInfo,
    debugMessage,
  };
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const catalogId = formData.get("catalogId");

  if (intent === "save") {
    const productId = formData.get("productId");
    const hiddenVariantIds = formData.getAll("hiddenVariantIds");
    await prisma.productOverride.upsert({
      where: { catalogId_productId: { catalogId, productId } },
      update: { hiddenVariantIds },
      create: { catalogId, productId, hiddenVariantIds },
    });
    return { ok: true, intent: "save", productId };
  }

  if (intent === "save_bulk") {
    const bulkData = JSON.parse(formData.get("bulkData"));
    const operations = Object.keys(bulkData).map((productId) => {
      const hiddenVariantIds = bulkData[productId];
      return prisma.productOverride.upsert({
        where: { catalogId_productId: { catalogId, productId } },
        update: { hiddenVariantIds },
        create: { catalogId, productId, hiddenVariantIds },
      });
    });
    await prisma.$transaction(operations);
    return { ok: true, intent: "save_bulk" };
  }

  if (intent === "delete") {
    const productId = formData.get("productId");
    await prisma.productOverride.deleteMany({ where: { catalogId, productId } });
    return { ok: true, intent: "delete", productId };
  }

  return { ok: false };
}

export default function CatalogOverrides() {
  const {
    catalogDbId, catalogGid, catalogName, products, overridesMap,
    globalHiddenSkus, hiddenVariantTypes, allVariantTypes, pageInfo, debugMessage,
  } = useLoaderData();

  const navigate = useNavigate();

  // Two separate fetchers so single-save and bulk-save loading states are independent.
  const saveFetcher = useFetcher();
  const bulkFetcher = useFetcher();

  const isSingleSaving = saveFetcher.state !== "idle";
  const isBulkSaving = bulkFetcher.state !== "idle";

  const [pendingHidden, setPendingHidden] = useState({});
  const initialHidden = useRef({});
  const [variantFilter, setVariantFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");

  // Track which single productId is mid-save so we can mark it done when fetcher settles.
  const singleSaveRef = useRef(null);
  // Track the payload of the last bulk save so we can update initialHidden when it settles.
  const bulkSavePayloadRef = useRef(null);

  useEffect(() => {
    const initial = {};
    if (products) {
      products.forEach((p) => {
        if (overridesMap[p.id] !== undefined) {
          // Override exists — it is the complete source of truth for this product.
          // Do NOT merge blanket rules on top; the override fully controls visibility.
          initial[p.id] = overridesMap[p.id] || [];
        } else {
          // No override — compute the effective hidden state from blanket rules.
          const fromMaster = p.variants.nodes
            .filter((v) => {
              const variantSku = (v.sku || "").trim().toUpperCase();
              return globalHiddenSkus.some((gs) => gs.trim().toUpperCase() === variantSku);
            })
            .map((v) => v.id);
          const bulkType = p.variants.nodes
            .filter((v) => hiddenVariantTypes.some((t) => v.title.toLowerCase().includes(t.toLowerCase())))
            .map((v) => v.id);
          initial[p.id] = Array.from(new Set([...fromMaster, ...bulkType]));
        }
      });
    }
    initialHidden.current = initial;
    setPendingHidden(initial);
  }, [products, overridesMap, globalHiddenSkus, hiddenVariantTypes]);

  // When a single-product save completes, sync initialHidden and show toast.
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.ok && singleSaveRef.current) {
      const { productId, hidden } = singleSaveRef.current;
      initialHidden.current = { ...initialHidden.current, [productId]: hidden };
      singleSaveRef.current = null;
      shopify.toast.show("Saved!");
    }
  }, [saveFetcher.state, saveFetcher.data]);

  // When a bulk save completes, sync initialHidden for every saved product and show toast.
  useEffect(() => {
    if (bulkFetcher.state === "idle" && bulkFetcher.data?.ok && bulkSavePayloadRef.current) {
      const payload = bulkSavePayloadRef.current;
      const next = { ...initialHidden.current };
      Object.entries(payload).forEach(([productId, hiddenIds]) => {
        next[productId] = hiddenIds;
      });
      initialHidden.current = next;
      bulkSavePayloadRef.current = null;
      shopify.toast.show("All changes saved!");
      // Force re-render so dirty badges clear immediately.
      setPendingHidden((prev) => ({ ...prev }));
    }
  }, [bulkFetcher.state, bulkFetcher.data]);

  const filteredProducts = useMemo(() => {
    if (!products) return [];
    let filtered = products;
    if (variantFilter !== "all") {
      filtered = filtered.filter((p) => p.variants.nodes.some((v) => v.title.startsWith(variantFilter)));
    }
    if (searchInput.trim() !== "") {
      const lowerSearch = searchInput.toLowerCase();
      filtered = filtered.filter((p) => p.title.toLowerCase().includes(lowerSearch));
    }
    return filtered;
  }, [products, variantFilter, searchInput]);

  // Variant IDs already covered by blanket rules — excluded from manual overrides.
  const getBulkHiddenIds = (product) =>
    product.variants.nodes
      .filter((v) => {
        const sku = (v.sku || "").trim().toUpperCase();
        return (
          hiddenVariantTypes.some((t) => v.title.toLowerCase().includes(t.toLowerCase())) ||
          globalHiddenSkus.some((gs) => gs.trim().toUpperCase() === sku)
        );
      })
      .map((v) => v.id);

  const handleVariantToggle = (productId, variantId) => {
    setPendingHidden((prev) => {
      const current = prev[productId] || [];
      return {
        ...prev,
        [productId]: current.includes(variantId)
          ? current.filter((v) => v !== variantId)
          : [...current, variantId],
      };
    });
  };

  const handleSave = (productId) => {
    // Save the COMPLETE current hidden state for this product.
    // The override record is the full source of truth — it overrides blanket rules entirely,
    // which is what allows explicitly showing a normally-blocked type (e.g. Shipper) for
    // a specific product.
    const allHiddenForProduct = pendingHidden[productId] || [];

    singleSaveRef.current = { productId, hidden: allHiddenForProduct };

    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("catalogId", catalogDbId);
    formData.append("productId", productId);
    allHiddenForProduct.forEach((v) => formData.append("hiddenVariantIds", v));
    saveFetcher.submit(formData, { method: "post" });
  };

  const handleHideAllVisible = () => {
    setPendingHidden((prev) => {
      const next = { ...prev };
      filteredProducts.forEach((p) => {
        const allIds = p.variants.nodes.map((v) => v.id);
        next[p.id] = Array.from(new Set([...(next[p.id] || []), ...allIds]));
      });
      return next;
    });
  };

  const handleShowAllVisible = () => {
    setPendingHidden((prev) => {
      const next = { ...prev };
      filteredProducts.forEach((p) => {
        const allIds = p.variants.nodes.map((v) => v.id);
        next[p.id] = (next[p.id] || []).filter((id) => !allIds.includes(id));
      });
      return next;
    });
  };

  const handleSaveAllDirty = () => {
    const payload = {};
    let dirtyCount = 0;

    products.forEach((p) => {
      const currentHidden = pendingHidden[p.id] || [];
      const baseHidden = initialHidden.current[p.id] || [];
      const isDirty =
        JSON.stringify([...currentHidden].sort()) !== JSON.stringify([...baseHidden].sort());

      if (isDirty) {
        payload[p.id] = currentHidden; // complete list — override takes full control
        dirtyCount++;
      }
    });

    if (dirtyCount === 0) {
      shopify.toast.show("No changes to save.");
      return;
    }

    // Snapshot payload so the effect can sync initialHidden when the fetcher settles.
    bulkSavePayloadRef.current = payload;

    const formData = new FormData();
    formData.append("intent", "save_bulk");
    formData.append("catalogId", catalogDbId);
    formData.append("bulkData", JSON.stringify(payload));
    bulkFetcher.submit(formData, { method: "post" });
    shopify.toast.show(`Saving ${dirtyCount} product${dirtyCount !== 1 ? "s" : ""}…`);
  };

  const hasUnsavedChanges = products.some((p) => {
    const cur = pendingHidden[p.id] || [];
    const base = initialHidden.current[p.id] || [];
    return JSON.stringify([...cur].sort()) !== JSON.stringify([...base].sort());
  });

  const dirtyCount = products.filter((p) => {
    const cur = pendingHidden[p.id] || [];
    const base = initialHidden.current[p.id] || [];
    return JSON.stringify([...cur].sort()) !== JSON.stringify([...base].sort());
  }).length;

  return (
    <s-page heading={`Product Visibility: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-layout>
        <s-layout-section>

          {/* Instructions */}
          <s-box padding="base" background="bg-surface-secondary" borderRadius="base"
            style={{ marginBottom: "20px", border: "1px solid #e1e3e5" }}>
            <s-block-stack gap="tight">
              <s-text variant="headingMd" as="h2">🎯 How to use this page</s-text>
              <s-text>
                Each box below is a pack size this customer can order. <b>Tick = Visible. Untick = Hidden.</b>
              </s-text>
              <div style={{ display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" }}>
                <div style={{ padding: "8px 14px", background: "#e3f1df", borderRadius: "6px", fontSize: "13px", fontWeight: "600", color: "#008060" }}>
                  ✅ Ticked = Customer CAN order this size
                </div>
                <div style={{ padding: "8px 14px", background: "#ffeaeb", borderRadius: "6px", fontSize: "13px", fontWeight: "600", color: "#d72c0d" }}>
                  ⬜ Unticked = Customer CANNOT order this size (shown in red)
                </div>
              </div>
              <s-text tone="subdued" style={{ marginTop: "4px" }}>
                Use <b>Hide All / Show All</b> to bulk change, then hit <b>Save All Changes</b> to apply.
              </s-text>
            </s-block-stack>
          </s-box>

          {/* Sticky save bar */}
          {hasUnsavedChanges && (
            <div style={{
              position: "sticky", top: 0, zIndex: 100,
              background: "#1a1a2e", color: "#fff",
              padding: "12px 20px", borderRadius: "8px", marginBottom: "16px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            }}>
              <span style={{ fontSize: "14px" }}>
                ✏️ <b>{dirtyCount} product{dirtyCount !== 1 ? "s" : ""}</b> with unsaved changes
              </span>
              <s-button variant="primary" tone="success" onClick={handleSaveAllDirty}
                disabled={isBulkSaving || undefined}>
                {isBulkSaving ? "Saving…" : "💾 Save All Changes"}
              </s-button>
            </div>
          )}

          <s-section heading={`Products in this Catalog (${products.length})`}>

            {/* Search */}
            <div style={{ marginBottom: "16px" }}>
              <s-text-field
                label="Search products"
                value={searchInput}
                onInput={(e) => setSearchInput(e.target.value)}
                placeholder="Type a product name to filter..."
              />
            </div>

            {/* Filters + bulk toggles */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: "13px", color: "#6d7175" }}>Filter by pack type:</span>
                <s-button variant={variantFilter === "all" ? "primary" : "secondary"} size="slim"
                  onClick={() => setVariantFilter("all")}>All</s-button>
                {allVariantTypes.map((type) => (
                  <s-button key={type} variant={variantFilter === type ? "primary" : "secondary"}
                    size="slim" onClick={() => setVariantFilter(type)}>{type}</s-button>
                ))}
              </div>
              {filteredProducts.length > 0 && (
                <div style={{ display: "flex", gap: "6px" }}>
                  <s-button variant="secondary" size="slim" onClick={handleHideAllVisible}>Hide All</s-button>
                  <s-button variant="secondary" size="slim" onClick={handleShowAllVisible}>Show All</s-button>
                </div>
              )}
            </div>

            {/* Product cards */}
            <s-stack direction="block" gap="base">
              {filteredProducts.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px", border: "1px solid #e1e3e5", borderRadius: "8px", color: "#6d7175" }}>
                  {searchInput ? (
                    <>
                      <div style={{ fontSize: "32px", marginBottom: "8px" }}>🔍</div>
                      <div style={{ fontWeight: "600" }}>No products match "{searchInput}"</div>
                      <div style={{ fontSize: "13px", marginTop: "4px" }}>Try a different search term or clear the filter.</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: "32px", marginBottom: "8px" }}>📦</div>
                      <div style={{ fontWeight: "600" }}>No products found in this catalog</div>
                      <div style={{ fontSize: "13px", marginTop: "4px" }}>
                        {debugMessage || "Make sure products are assigned to this customer in Shopify B2B settings."}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                filteredProducts.map((product) => {
                  const currentHidden = pendingHidden[product.id] || [];
                  const baseHidden = initialHidden.current[product.id] || [];
                  const isDirty =
                    JSON.stringify([...currentHidden].sort()) !== JSON.stringify([...baseHidden].sort());
                  const hasCustomRule = overridesMap[product.id] !== undefined;
                  const allHidden = product.variants.nodes.every((v) => currentHidden.includes(v.id));
                  const someHidden = product.variants.nodes.some((v) => currentHidden.includes(v.id));
                  // Is THIS specific product's single-save in flight?
                  const isSavingThis =
                    isSingleSaving && singleSaveRef.current?.productId === product.id;

                  return (
                    <div key={product.id} style={{
                      border: `1px solid ${isDirty ? "#f59e0b" : hasCustomRule ? "#d72c0d" : "#e1e3e5"}`,
                      borderRadius: "8px", padding: "16px",
                      background: allHidden ? "#fff4f4" : isDirty ? "#fffbeb" : "#fff",
                    }}>
                      {/* Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
                        <div>
                          <div style={{ fontWeight: "700", fontSize: "15px" }}>{product.title}</div>
                          <div style={{ display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" }}>
                            {allHidden && (
                              <span style={{ fontSize: "11px", background: "#d72c0d", color: "#fff", padding: "2px 8px", borderRadius: "12px", fontWeight: "600" }}>All hidden</span>
                            )}
                            {!allHidden && someHidden && (
                              <span style={{ fontSize: "11px", background: "#ffeaeb", color: "#d72c0d", padding: "2px 8px", borderRadius: "12px", fontWeight: "600" }}>Partial restriction</span>
                            )}
                            {hasCustomRule && !isDirty && (
                              <span style={{ fontSize: "11px", background: "#fff3cd", color: "#856404", padding: "2px 8px", borderRadius: "12px", fontWeight: "500" }}>Custom rule saved</span>
                            )}
                            {isDirty && (
                              <span style={{ fontSize: "11px", background: "#f59e0b", color: "#fff", padding: "2px 8px", borderRadius: "12px", fontWeight: "600" }}>Unsaved changes</span>
                            )}
                          </div>
                        </div>
                        {isDirty && (
                          <s-button variant="primary" size="slim"
                            onClick={() => handleSave(product.id)}
                            disabled={isSavingThis || undefined}>
                            {isSavingThis ? "Saving…" : "Save"}
                          </s-button>
                        )}
                      </div>

                      {/* Variant checkboxes */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                        {product.variants.nodes.map((variant) => {
                          const isHidden = currentHidden.includes(variant.id);
                          return (
                            <div
                              key={variant.id}
                              onClick={() => handleVariantToggle(product.id, variant.id)}
                              style={{
                                padding: "8px 12px",
                                border: `1px solid ${isHidden ? "#d72c0d" : "#c9cccf"}`,
                                borderRadius: "6px",
                                background: isHidden ? "#ffeaeb" : "#f6f6f7",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontSize: "13px",
                                fontWeight: isHidden ? "600" : "400",
                                color: isHidden ? "#d72c0d" : "#1a1a2e",
                              }}
                            >
                              <s-checkbox
                                label={variant.title}
                                checked={!isHidden}
                                onClick={(e) => e.stopPropagation()}
                                onInput={() => handleVariantToggle(product.id, variant.id)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </s-stack>

            {/* Pagination */}
            {products.length > 0 && (pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "24px" }}>
                <s-button variant="secondary" disabled={!pageInfo.hasPreviousPage || undefined}
                  onClick={() => {
                    if (hasUnsavedChanges && !window.confirm("You have unsaved changes. Leave this page and lose them?")) return;
                    navigate(`/app/catalog-overrides?catalogId=${encodeURIComponent(catalogGid)}&catalogName=${encodeURIComponent(catalogName)}&before=${pageInfo.startCursor}`);
                  }}>← Previous</s-button>
                <s-button variant="secondary" disabled={!pageInfo.hasNextPage || undefined}
                  onClick={() => {
                    if (hasUnsavedChanges && !window.confirm("You have unsaved changes. Leave this page and lose them?")) return;
                    navigate(`/app/catalog-overrides?catalogId=${encodeURIComponent(catalogGid)}&catalogName=${encodeURIComponent(catalogName)}&after=${pageInfo.endCursor}`);
                  }}>Next →</s-button>
              </div>
            )}
          </s-section>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
