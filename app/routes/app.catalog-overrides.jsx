import { redirect } from "react-router";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "react-router";
import { useState, useMemo } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");
  const search = url.searchParams.get("search") || "";
  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  if (!catalogId) return redirect("/app/catalog-manager");
  const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;

  const paginationArgs = before ? `last: 50, before: "${before}"` : after ? `first: 50, after: "${after}"` : `first: 50`;

  const response = await admin.graphql(
    `query searchProducts($query: String) {
      products(${paginationArgs}, query: $query) {
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes {
          id
          title
          variants(first: 50) { nodes { id title sku } }
        }
      }
    }`,
    { variables: { query: search || undefined } }
  );

  const data = await response.json();
  const products = data.data.products.nodes;
  const pageInfo = data.data.products.pageInfo;

  const [overrides, rule] = await Promise.all([
    prisma.productOverride.findMany({ where: { catalogId: cleanId } }),
    prisma.catalogRule.findUnique({ where: { catalogId: cleanId } }),
  ]);

  const globalHiddenSkus = rule ? rule.hiddenVariantIds : [];
  const hiddenVariantTypes = rule ? rule.hiddenVariantTypes : [];
  const overridesMap = {};
  overrides.forEach((o) => { overridesMap[o.productId] = o.hiddenVariantIds; });

  const allVariantTypes = new Set();
  products.forEach((p) => {
    p.variants.nodes.forEach((v) => {
      const match = v.title.match(/^([A-Za-z]+)/);
      if (match) allVariantTypes.add(match[1]);
    });
  });

  return { catalogId: cleanId, catalogName, products, overridesMap, globalHiddenSkus, hiddenVariantTypes, search, allVariantTypes: Array.from(allVariantTypes).sort(), pageInfo };
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const catalogId = formData.get("catalogId");
  const catalogName = formData.get("catalogName");
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

  return redirect(`/app/catalog-overrides?catalogId=${encodeURIComponent(catalogId)}&catalogName=${encodeURIComponent(catalogName)}`);
}

export default function CatalogOverrides() {
  const { catalogId, catalogName, products, overridesMap, globalHiddenSkus, hiddenVariantTypes, search, allVariantTypes, pageInfo } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [pendingHidden, setPendingHidden] = useState(() => {
    const initial = {};
    products.forEach((p) => { initial[p.id] = overridesMap[p.id] ? [...overridesMap[p.id]] : []; });
    return initial;
  });

  const [variantFilter, setVariantFilter] = useState("all");
  const [searchInput, setSearchInput] = useState(search);

  const filteredProducts = useMemo(() => {
    if (variantFilter === "all") return products;
    return products.filter((p) => p.variants.nodes.some((v) => v.title.startsWith(variantFilter)));
  }, [products, variantFilter]);

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
    formData.append("catalogName", catalogName);
    formData.append("productId", productId);
    (pendingHidden[productId] || []).forEach((v) => formData.append("hiddenVariantIds", v));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading={`Overrides: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-section heading="Exceptions per Product">
        <s-paragraph>
          Red variants are hidden. {globalHiddenSkus.length > 0 ? "Some are hidden by Master SKU rules." : ""}
        </s-paragraph>
        
        <s-stack direction="inline" gap="base" style={{ marginTop: "12px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <s-text-field label="Search Product" value={searchInput} onInput={(e) => setSearchInput(e.target.value)} />
          </div>
          <s-button onClick={() => navigate(`/app/catalog-overrides?catalogId=${catalogId}&catalogName=${catalogName}&search=${searchInput}`)}>Search</s-button>
        </s-stack>

        <s-stack direction="block" gap="base" style={{ marginTop: "16px" }}>
          {filteredProducts.map((product) => {
            const hasOverride = !!overridesMap[product.id];
            const currentHidden = pendingHidden[product.id] || [];
            const isDirty = JSON.stringify([...currentHidden].sort()) !== JSON.stringify([...(overridesMap[product.id] || [])].sort());

            return (
              <s-box key={product.id} padding="base" borderWidth="base" borderRadius="base" background={hasOverride ? "highlight" : "subdued"}>
                <s-text fontWeight="bold" style={{ marginBottom: "8px", display: "block" }}>{product.title}</s-text>
                <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                  {product.variants.nodes.map((variant) => {
                    const isGloballyHidden = globalHiddenSkus.includes(variant.sku);
                    const isBulkTypeHidden = hiddenVariantTypes.some(t => variant.title.includes(t));
                    const isHidden = currentHidden.includes(variant.id) || isGloballyHidden || isBulkTypeHidden;

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
          })}
        </s-stack>
      </s-section>
    </s-page>
  );
}