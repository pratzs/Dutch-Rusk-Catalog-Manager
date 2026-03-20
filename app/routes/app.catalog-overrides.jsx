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

  if (!catalogId) return redirect("/app/catalog-manager");

  const response = await admin.graphql(
    `query searchProducts($query: String!) {
      products(first: 50, query: $query) {
        nodes {
          id
          title
          variants(first: 50) {
            nodes {
              id
              title
            }
          }
        }
      }
    }`,
    { variables: { query: search } }
  );

  const data = await response.json();
  const products = data.data.products.nodes;

  const overrides = await prisma.productOverride.findMany({
    where: { catalogId },
  });
  const overridesMap = {};
  overrides.forEach((o) => {
    overridesMap[o.productId] = o.hiddenVariantIds;
  });

  const rule = await prisma.catalogRule.findUnique({
    where: { catalogId },
  });
  const hiddenVariantTypes = rule ? rule.hiddenVariantTypes : [];

  // Collect all unique variant types across all products
  const allVariantTypes = new Set();
  products.forEach((p) => {
    p.variants.nodes.forEach((v) => {
      const match = v.title.match(/^([A-Za-z]+)/);
      if (match) allVariantTypes.add(match[1]);
    });
  });

  return {
    catalogId,
    catalogName,
    products,
    overridesMap,
    hiddenVariantTypes,
    search,
    allVariantTypes: Array.from(allVariantTypes).sort(),
  };
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
    await prisma.productOverride.deleteMany({
      where: { catalogId, productId },
    });
  }

  return redirect(
    `/app/catalog-overrides?catalogId=${encodeURIComponent(catalogId)}&catalogName=${encodeURIComponent(catalogName)}`
  );
}

export default function CatalogOverrides() {
  const {
    catalogId,
    catalogName,
    products,
    overridesMap,
    hiddenVariantTypes,
    search,
    allVariantTypes,
  } = useLoaderData();

  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [pendingHidden, setPendingHidden] = useState(() => {
    const initial = {};
    products.forEach((p) => {
      initial[p.id] = overridesMap[p.id] ? [...overridesMap[p.id]] : [];
    });
    return initial;
  });

  const [variantFilter, setVariantFilter] = useState("all");
  const [searchInput, setSearchInput] = useState(search);

  // Filter products by selected variant type
  const filteredProducts = useMemo(() => {
    if (variantFilter === "all") return products;
    return products.filter((p) =>
      p.variants.nodes.some((v) => v.title.startsWith(variantFilter))
    );
  }, [products, variantFilter]);

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
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    formData.append("productId", productId);
    (pendingHidden[productId] || []).forEach((v) =>
      formData.append("hiddenVariantIds", v)
    );
    submit(formData, { method: "post" });
  };

  const handleDelete = (productId) => {
    const formData = new FormData();
    formData.append("intent", "delete");
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    formData.append("productId", productId);
    submit(formData, { method: "post" });
  };

  const handleSearch = () => {
    navigate(
      `/app/catalog-overrides?catalogId=${encodeURIComponent(catalogId)}&catalogName=${encodeURIComponent(catalogName)}&search=${encodeURIComponent(searchInput)}`
    );
  };

  return (
    <s-page
      heading={`Product Overrides: ${catalogName}`}
      back-action-url="/app/catalog-manager"
    >
      <s-section heading="Find & override variants per product">
        <s-paragraph>
          {hiddenVariantTypes.length > 0 ? (
            <>Bulk rule hides: <strong>{hiddenVariantTypes.join(", ")}</strong>. Use overrides below to make exceptions per product.</>
          ) : (
            <>No bulk rules set. Use overrides to hide specific variants on individual products.</>
          )}
        </s-paragraph>

        {/* Search + Filter bar */}
        <s-stack direction="inline" gap="base" style={{ marginTop: "12px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <s-text-field
              label="Search by product name"
              placeholder="e.g. Peppermint, Cadbury..."
              value={searchInput}
              onInput={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <s-button variant="secondary" onClick={handleSearch}>
            Search
          </s-button>
        </s-stack>

        {/* Variant type filter */}
        <s-stack direction="inline" gap="tight" style={{ marginTop: "12px", flexWrap: "wrap" }}>
          <s-text>Filter by variant type:</s-text>
          <s-button
            variant={variantFilter === "all" ? "primary" : "secondary"}
            size="slim"
            onClick={() => setVariantFilter("all")}
          >
            All
          </s-button>
          {allVariantTypes.map((type) => (
            <s-button
              key={type}
              variant={variantFilter === type ? "primary" : "secondary"}
              size="slim"
              onClick={() => setVariantFilter(type)}
            >
              {type}
            </s-button>
          ))}
        </s-stack>

        <s-text style={{ marginTop: "8px" }} tone="subdued">
          Showing {filteredProducts.length} of {products.length} products
          {variantFilter !== "all" ? ` with "${variantFilter}" variants` : ""}
        </s-text>

        {/* Product list with variants always visible */}
        <s-stack direction="block" gap="base" style={{ marginTop: "16px" }}>
          {filteredProducts.length === 0 ? (
            <s-paragraph>No products found. Try a different search or filter.</s-paragraph>
          ) : (
            filteredProducts.map((product) => {
              const hasOverride = !!overridesMap[product.id];
              const currentHidden = pendingHidden[product.id] || [];
              const isDirty =
                JSON.stringify(currentHidden.sort()) !==
                JSON.stringify((overridesMap[product.id] || []).slice().sort());

              return (
                <s-box
                  key={product.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background={hasOverride ? "highlight" : "subdued"}
                >
                  <s-stack direction="inline" gap="base" style={{ marginBottom: "12px" }}>
                    <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                      <s-text fontWeight="bold">{product.title}</s-text>
                      <s-text tone="subdued">
                        {hasOverride
                          ? `Override active — ${overridesMap[product.id].length} variant(s) hidden`
                          : "No override — bulk rules apply"}
                      </s-text>
                    </s-stack>
                    {hasOverride && (
                      <s-button
                        variant="secondary"
                        tone="critical"
                        size="slim"
                        onClick={() => handleDelete(product.id)}
                      >
                        Remove Override
                      </s-button>
                    )}
                  </s-stack>

                  {/* Variants always visible as checkboxes */}
                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                    {product.variants.nodes.map((variant) => (
                      <s-box
                        key={variant.id}
                        padding="tight"
                        borderWidth="base"
                        borderRadius="base"
                        background={currentHidden.includes(variant.id) ? "critical-subdued" : "surface"}
                      >
                        <s-checkbox
                          label={variant.title}
                          checked={currentHidden.includes(variant.id)}
                          onInput={() => handleVariantToggle(product.id, variant.id)}
                        />
                      </s-box>
                    ))}
                  </s-stack>

                  {isDirty && (
                    <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
                      <s-button
                        variant="primary"
                        onClick={() => handleSave(product.id)}
                        disabled={isSaving}
                      >
                        {isSaving ? "Saving..." : "Save Override"}
                      </s-button>
                    </div>
                  )}
                </s-box>
              );
            })
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How overrides work">
        <s-paragraph>
          Tick a variant to hide it for this catalog only. Overrides take
          priority over bulk rules.
        </s-paragraph>
        <s-paragraph>
          The Save button only appears when you make a change.
          Red background = hidden. Click "Remove Override" to go back
          to bulk rules.
        </s-paragraph>
        <s-paragraph>
          Use the variant type filter buttons to quickly find all products
          that have a specific variant — e.g. click "Shipper" to see only
          products with Shipper variants.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}