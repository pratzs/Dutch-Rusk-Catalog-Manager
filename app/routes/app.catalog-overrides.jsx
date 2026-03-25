import { redirect } from "react-router";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "react-router";
import { useState, useMemo, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");
  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  if (!catalogId) return redirect("/app/catalog-manager");

  const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
  const paginationArgs = before ? `last: 50, before: "${before}"` : after ? `first: 50, after: "${after}"` : `first: 50`;
  
  // Normalize the ID for the universal Node fetch
  const fullCatalogId = catalogId.includes("gid://") ? catalogId : `gid://shopify/Catalog/${cleanId}`;

  let products = [];
  let pageInfo = { hasNextPage: false, hasPreviousPage: false };
  let debugMessage = "";

  try {
    // STEP 1: Get the actual Publication ID for this Market Catalog
    const catResponse = await admin.graphql(
      `query getCat($id: ID!) {
        node(id: $id) {
          ... on Catalog {
            publication {
              id
            }
          }
        }
      }`,
      { variables: { id: fullCatalogId } }
    );

    const catJson = await catResponse.json();
    const pubId = catJson.data?.node?.publication?.id;

    if (pubId) {
      // Extract just the numbers for the search query
      const numericPubId = pubId.split("/").pop();
      
      // STEP 2: Use Shopify's native 'publication_id' filter to get ONLY assigned products
      const prodResponse = await admin.graphql(
        `query getPubProducts {
          products(${paginationArgs}, query: "publication_id:${numericPubId}") {
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            nodes {
              id
              title
              variants(first: 50) { nodes { id title sku } }
            }
          }
        }`
      );
      
      const prodJson = await prodResponse.json();
      
      if (prodJson.errors) {
        debugMessage = "Error fetching products: " + JSON.stringify(prodJson.errors);
      } else {
        products = prodJson.data?.products?.nodes || [];
        pageInfo = prodJson.data?.products?.pageInfo || pageInfo;
      }
    } else {
      debugMessage = "Error: Could not find a Publication assigned to this Market Catalog.";
    }
  } catch (error) {
    console.error("Loader Fetch Error:", error);
    debugMessage = "Exception: " + error.message;
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
    catalogId: cleanId, 
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
  const catalogId = formData.get("catalogId");
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
  const { catalogId, catalogName, products, overridesMap, globalHiddenSkus, hiddenVariantTypes, allVariantTypes, pageInfo, debugMessage } = useLoaderData();
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
    formData.append("catalogId", catalogId);
    formData.append("productId", productId);
    (pendingHidden[productId] || []).forEach((v) => formData.append("hiddenVariantIds", v));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading={`Overrides: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-section heading="Manage Visibility Exceptions">
        <s-paragraph>
          <b>Red background = Hidden.</b> Viewing only products strictly included in this Market Catalog.
        </s-paragraph>

        <s-stack direction="inline" gap="base" style={{ margin: "16px 0", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <s-text-field 
              label="Instant Search Assigned Products" 
              value={searchInput} 
              onInput={(e) => setSearchInput(e.target.value)} 
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
              <s-text fontWeight="bold">No products found in this specific catalog.</s-text>
              {/* This prints out exactly why it failed if it fails again */}
              {debugMessage && <s-text style={{ color: 'red', display: 'block', marginTop: '10px' }}>{debugMessage}</s-text>}
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
            <s-button variant="secondary" disabled={!pageInfo.hasPreviousPage} onClick={() => navigate(`/app/catalog-overrides?catalogId=${catalogId}&catalogName=${catalogName}&before=${pageInfo.startCursor}`)}>← Previous</s-button>
            <s-button variant="secondary" disabled={!pageInfo.hasNextPage} onClick={() => navigate(`/app/catalog-overrides?catalogId=${catalogId}&catalogName=${catalogName}&after=${pageInfo.endCursor}`)}>Next →</s-button>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}