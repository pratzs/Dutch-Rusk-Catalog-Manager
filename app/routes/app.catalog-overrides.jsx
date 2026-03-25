import { redirect } from "react-router";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "react-router";
import { useState, useMemo, useEffect } from "react";
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

  // Clean ID for Database saves
  const cleanId = originalCatalogId.includes("/") ? originalCatalogId.split("/").pop() : originalCatalogId;
  const paginationArgs = before ? `last: 50, before: "${before}"` : after ? `first: 50, after: "${after}"` : `first: 50`;
  
  let products = [];
  let pageInfo = { hasNextPage: false, hasPreviousPage: false };
  let debugMessage = "";
  
  // Keep the active GID intact for future page reloads
  let activeFullId = originalCatalogId.includes("gid://") ? originalCatalogId : `gid://shopify/Catalog/${cleanId}`;
  let pubId = null;

  // Helper to safely fetch Publication ID without crashing
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

  // STEP 1: Get Publication ID (Try standard Catalog, fallback to MarketCatalog)
  pubId = await getPubId(activeFullId);
  if (!pubId) {
    activeFullId = `gid://shopify/MarketCatalog/${cleanId}`;
    pubId = await getPubId(activeFullId);
  }

  // STEP 2: Strictly fetch products ONLY inside this publication
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
                variants(first: 50) { nodes { id title sku } }
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
    catalogDbId: cleanId, // For database
    catalogGid: activeFullId, // MUST use this for UI navigation
    catalogName, 
    products, 
    overridesMap, 
    globalHiddenSkus, 
    hiddenVariantTypes, 
    allVariantTypes: Array.from(allVariantTypes).sort(), 
    pageInfo,
    debugMessage
  };
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const catalogId = formData.get("catalogId"); // This receives catalogDbId
  const productId = formData.get("productId");

  if (intent === "save") {
    const hiddenVariantIds = formData.getAll("hiddenVariantIds");
    await prisma.productOverride.upsert({
      where: { catalogId_productId: { catalogId, productId } },
      update: { hiddenVariantIds },
      create: { catalogId, productId, hiddenVariantIds },
    });
  }

  if (intent === "delete") {
    await prisma.productOverride.deleteMany({ where: { catalogId, productId } });
  }

  return null;
}

export default function CatalogOverrides() {
  const { catalogDbId, catalogGid, catalogName, products, overridesMap, globalHiddenSkus, hiddenVariantTypes, allVariantTypes, pageInfo, debugMessage } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [pendingHidden, setPendingHidden] = useState({});
  const [variantFilter, setVariantFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    const initial = {};
    if (products) {
      products.forEach((p) => { 
        const manual = overridesMap[p.id] || [];
        const fromMaster = p.variants.nodes
          .filter(v => {
            const variantSku = (v.sku || "").trim().toUpperCase();
            return globalHiddenSkus.some(gs => gs.trim().toUpperCase() === variantSku);
          })
          .map(v => v.id);
        
        const bulkType = p.variants.nodes
          .filter(v => hiddenVariantTypes.some(t => v.title.toLowerCase().includes(t.toLowerCase())))
          .map(v => v.id);
        
        initial[p.id] = Array.from(new Set([...manual, ...fromMaster, ...bulkType])); 
      });
    }
    setPendingHidden(initial);
  }, [products, overridesMap, globalHiddenSkus, hiddenVariantTypes]);

  // Instant Client-Side Search
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

  const handleVariantToggle = (productId, variantId) => {
    setPendingHidden((prev) => {
      const current = prev[productId] || [];
      return { ...prev, [productId]: current.includes(variantId) ? current.filter((v) => v !== variantId) : [...current, variantId] };
    });
  };

  const handleSave = (productId) => {
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("catalogId", catalogDbId); // Save purely with the numeric ID
    formData.append("productId", productId);
    (pendingHidden[productId] || []).forEach((v) => formData.append("hiddenVariantIds", v));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading={`Overrides: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-section heading="Manage Visibility Exceptions">
        <s-paragraph>
          <b>Red background = Hidden.</b> Viewing only products strictly included in this Catalog.
        </s-paragraph>

        <s-stack direction="inline" gap="base" style={{ margin: "16px 0", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <s-text-field 
              label="Instant Search Assigned Products" 
              value={searchInput} 
              onInput={(e) => setSearchInput(e.target.value)} 
              placeholder="Start typing to filter instantly..."
            />
          </div>
        </s-stack>

        <s-stack direction="inline" gap="tight" style={{ marginBottom: "20px", flexWrap: "wrap" }}>
          <s-text>Filter:</s-text>
          <s-button variant={variantFilter === "all" ? "primary" : "secondary"} size="slim" onClick={() => setVariantFilter("all")}>All</s-button>
          {allVariantTypes.map((type) => (
            <s-button key={type} variant={variantFilter === type ? "primary" : "secondary"} size="slim" onClick={() => setVariantFilter(type)}>{type}</s-button>
          ))}
        </s-stack>

        <s-stack direction="block" gap="base">
          {filteredProducts.length === 0 ? (
            <s-box padding="base" background="surface" borderWidth="base" borderRadius="base">
              <s-text fontWeight="bold">{searchInput ? "No matches for your search." : "No products found in this specific catalog."}</s-text>
              {debugMessage && !searchInput && (
                <s-text style={{ color: 'red', display: 'block', marginTop: '10px' }}>Debug: {debugMessage}</s-text>
              )}
            </s-box>
          ) : (
            filteredProducts.map((product) => {
              const currentHidden = pendingHidden[product.id] || [];
              const savedHidden = overridesMap[product.id] || [];
              const isDirty = JSON.stringify([...currentHidden].sort()) !== JSON.stringify([...savedHidden].sort());

              return (
                <s-box key={product.id} padding="base" borderWidth="base" borderRadius="base" background={overridesMap[product.id] ? "highlight" : "subdued"}>
                  <s-text fontWeight="bold" style={{ marginBottom: "12px", display: "block" }}>{product.title}</s-text>
                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                    {product.variants.nodes.map((variant) => {
                      const isHidden = currentHidden.includes(variant.id);
                      return (
                        <s-box key={variant.id} padding="tight" borderWidth="base" borderRadius="base" background={isHidden ? "critical-subdued" : "surface"}>
                          <s-checkbox label={variant.title} checked={isHidden} onInput={() => handleVariantToggle(product.id, variant.id)} />
                        </s-box>
                      );
                    })}
                  </s-stack>
                  {isDirty && (
                    <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
                      <s-button variant="primary" onClick={() => handleSave(product.id)} disabled={isSaving}>Save Override</s-button>
                    </div>
                  )}
                </s-box>
              );
            })
          )}
        </s-stack>

        {products.length > 0 && (
          <s-stack direction="inline" gap="base" style={{ marginTop: "24px", justifyContent: "space-between" }}>
            {/* Navigates safely while retaining the crucial MarketCatalog GID */}
            <s-button variant="secondary" disabled={!pageInfo.hasPreviousPage} onClick={() => navigate(`/app/catalog-overrides?catalogId=${encodeURIComponent(catalogGid)}&catalogName=${encodeURIComponent(catalogName)}&before=${pageInfo.startCursor}`)}>← Previous</s-button>
            <s-button variant="secondary" disabled={!pageInfo.hasNextPage} onClick={() => navigate(`/app/catalog-overrides?catalogId=${encodeURIComponent(catalogGid)}&catalogName=${encodeURIComponent(catalogName)}&after=${pageInfo.endCursor}`)}>Next →</s-button>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}