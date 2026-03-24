import { redirect } from "react-router";
import { useLoaderData, useSubmit, useNavigate, useNavigation } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function extractVariantType(title) {
  if (!title) return null;
  const match = title.match(/^([A-Za-z]+)/);
  return match ? match[1] : title;
}

async function fetchAllVariantTypes(admin) {
  let allTypes = new Set();
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = cursor
      ? `query { products(first: 250, after: "${cursor}") { pageInfo { hasNextPage endCursor } nodes { variants(first: 50) { nodes { title } } } } }`
      : `query { products(first: 250) { pageInfo { hasNextPage endCursor } nodes { variants(first: 50) { nodes { title } } } } }`;

    const response = await admin.graphql(query);
    const data = await response.json();
    const products = data.data.products.nodes;

    products.forEach((product) => {
      product.variants.nodes.forEach((variant) => {
        const type = extractVariantType(variant.title);
        if (type) allTypes.add(type);
      });
    });

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return Array.from(allTypes).sort();
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  let catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");

  if (!catalogId) return redirect("/app/catalog-manager");

  const cleanCatalogId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;

  const [rule, variantTypes] = await Promise.all([
    prisma.catalogRule.findUnique({ where: { catalogId: cleanCatalogId } }),
    fetchAllVariantTypes(admin),
  ]);

  return {
    catalogId,
    catalogName,
    hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
    hiddenVariantIds: rule ? rule.hiddenVariantIds : [],
    variantTypes,
  };
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  let catalogId = formData.get("catalogId");
  const catalogName = formData.get("catalogName");
  const hiddenVariantTypes = formData.getAll("hiddenVariantTypes");
  const skusRaw = formData.get("hiddenVariantIds") || "";
  const hiddenVariantIds = skusRaw.split(",").map(s => s.trim()).filter(s => s !== "");

  const cleanCatalogId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;

  await prisma.catalogRule.upsert({
    where: { catalogId: cleanCatalogId },
    update: { hiddenVariantTypes, hiddenVariantIds, catalogName },
    create: { catalogId: cleanCatalogId, catalogName, hiddenVariantTypes, hiddenVariantIds },
  });

  return redirect("/app/catalog-manager");
}

export default function CatalogRules() {
  const { catalogId, catalogName, hiddenVariantTypes, hiddenVariantIds, variantTypes } = useLoaderData();
  const [selected, setSelected] = useState(hiddenVariantTypes);
  const [skuList, setSkuList] = useState(hiddenVariantIds.join(", "));
  
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const handleToggle = (value) => {
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    formData.append("hiddenVariantIds", skuList);
    selected.forEach((v) => formData.append("hiddenVariantTypes", v));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading={`Rules for: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-section heading="Step 1: Bulk Variant Types">
        <s-paragraph>Hide all variants of a certain type (e.g., hide all "Shipper" variants) for this catalog.</s-paragraph>
        <s-stack direction="block" gap="tight" style={{ marginTop: "12px" }}>
          {variantTypes.map((type) => (
            <s-checkbox
              key={type}
              label={`Hide all "${type}" variants`}
              checked={selected.includes(type)}
              onInput={() => handleToggle(type)}
            />
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Step 2: Restricted SKUs (The Locksmith Migration)" style={{ marginTop: "24px" }}>
        <s-paragraph>Paste individual SKUs below to hide them. These act as global exceptions across the entire catalog.</s-paragraph>
        <textarea
          style={{ width: "100%", minHeight: "200px", marginTop: "12px", padding: "12px", fontFamily: "monospace", borderRadius: "6px", border: "1px solid #ccc" }}
          value={skuList}
          onChange={(e) => setSkuList(e.target.value)}
          placeholder="Paste SKUs here, separated by commas..."
        />
      </s-section>

      <div style={{ marginTop: "24px", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <s-button variant="secondary" onClick={() => navigate("/app/catalog-manager")}>Cancel</s-button>
        <s-button variant="primary" onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Rules"}
        </s-button>
      </div>
    </s-page>
  );
}