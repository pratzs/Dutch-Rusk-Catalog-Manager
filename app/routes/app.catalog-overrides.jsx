import { redirect } from "react-router";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "react-router";
import { useState } from "react";
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
      products(first: 20, query: $query) {
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

  return { catalogId, catalogName, products, overridesMap, hiddenVariantTypes, search };
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
  const { catalogId, catalogName, products, overridesMap, hiddenVariantTypes, search } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [expandedProduct, setExpandedProduct] = useState(null);
  const [pendingHidden, setPendingHidden] = useState({});
  const isSaving = navigation.state === "submitting";

  const handleExpand = (productId) => {
    setExpandedProduct(expandedProduct === productId ? null : productId);
    setPendingHidden((prev) => ({
      ...prev,
      [productId]: overridesMap[productId] || [],
    }));
  };

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
    setExpandedProduct(null);
  };

  const handleDelete = (productId) => {
    const formData = new FormData();
    formData.append("intent", "delete");
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    formData.append("productId", productId);
    submit(formData, { method: "post" });
  };

  const handleSearch = (e) => {
    if (e.key === "Enter") {
      navigate(
        `/app/catalog-overrides?catalogId=${encodeURIComponent(catalogId)}&catalogName=${encodeURIComponent(catalogName)}&search=${encodeURIComponent(e.target.value)}`
      );
    }
  };

  return (
    <s-page
      heading={`Product Overrides: ${catalogName}`}
      back-action-url="/app/catalog-manager"
    >
      <s-section heading="Override bulk rules per product">
        <s-paragraph>
          By default, bulk rules apply to all products. Use overrides to show
          or hide specific variants on individual products only.
          {hiddenVariantTypes.length > 0 && (
            <> Bulk rule currently hides: <strong>{hiddenVariantTypes.join(", ")}</strong>.</>
          )}
        </s-paragraph>

        <s-text-field
          label="Search products"
          placeholder="Type product name and press Enter"
          defaultValue={search}
          onKeyDown={handleSearch}
        />

        <s-stack direction="block" gap="base" style={{ marginTop: "16px" }}>
          {products.map((product) => {
            const hasOverride = !!overridesMap[product.id];
            const isExpanded = expandedProduct === product.id;
            const currentHidden = pendingHidden[product.id] || overridesMap[product.id] || [];

            return (
              <s-box
                key={product.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background={hasOverride ? "highlight" : "subdued"}
              >
                <s-stack direction="inline" gap="base" align="center">
                  <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                    <s-text fontWeight="bold">{product.title}</s-text>
                    <s-text>
                      {hasOverride
                        ? `Override active — ${overridesMap[product.id].length} variant(s) hidden`
                        : "No override — bulk rules apply"}
                    </s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <s-button
                      variant="secondary"
                      onClick={() => handleExpand(product.id)}
                    >
                      {isExpanded ? "Cancel" : "Set Override"}
                    </s-button>
                    {hasOverride && (
                      <s-button
                        variant="secondary"
                        tone="critical"
                        onClick={() => handleDelete(product.id)}
                      >
                        Remove Override
                      </s-button>
                    )}
                  </s-stack>
                </s-stack>

                {isExpanded && (
                  <s-box padding="base" style={{ marginTop: "12px" }}>
                    <s-paragraph>
                      Tick the variants to HIDE for this product only:
                    </s-paragraph>
                    <s-stack direction="block" gap="tight" style={{ marginTop: "8px" }}>
                      {product.variants.nodes.map((variant) => (
                        <s-checkbox
                          key={variant.id}
                          label={variant.title}
                          checked={currentHidden.includes(variant.id)}
                          onInput={() => handleVariantToggle(product.id, variant.id)}
                        />
                      ))}
                    </s-stack>
                    <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
                      <s-button
                        variant="primary"
                        onClick={() => handleSave(product.id)}
                        disabled={isSaving}
                      >
                        {isSaving ? "Saving..." : "Save Override"}
                      </s-button>
                    </div>
                  </s-box>
                )}
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How overrides work">
        <s-paragraph>
          Overrides take priority over bulk rules for specific products.
        </s-paragraph>
        <s-paragraph>
          Example: Bulk rule hides all Shippers from Night N Day — but for
          one specific product you want to show the Shipper. Set an override
          on that product to control exactly which variants show.
        </s-paragraph>
        <s-paragraph>
          To go back to bulk rules, click "Remove Override".
        </s-paragraph>
      </s-section>
    </s-page>
  );
}