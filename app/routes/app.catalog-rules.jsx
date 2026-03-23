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

  // NORMALIZE: Ensure we look up the numeric ID only
  const cleanCatalogId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;

  const [rule, variantTypes] = await Promise.all([
    prisma.catalogRule.findUnique({ where: { catalogId: cleanCatalogId } }),
    fetchAllVariantTypes(admin),
  ]);

  return {
    catalogId, // We keep the original for the form
    catalogName,
    hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
    variantTypes,
  };
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  let catalogId = formData.get("catalogId");
  const catalogName = formData.get("catalogName");
  const hiddenVariantTypes = formData.getAll("hiddenVariantTypes");

  // NORMALIZE: Ensure we save the numeric ID only
  const cleanCatalogId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;

  await prisma.catalogRule.upsert({
    where: { catalogId: cleanCatalogId },
    update: { hiddenVariantTypes, catalogName },
    create: { catalogId: cleanCatalogId, catalogName, hiddenVariantTypes },
  });

  return redirect("/app/catalog-manager");
}

export default function CatalogRules() {
  const { catalogId, catalogName, hiddenVariantTypes, variantTypes } = useLoaderData();
  const [selected, setSelected] = useState(hiddenVariantTypes);
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
    selected.forEach((v) => formData.append("hiddenVariantTypes", v));
    submit(formData, { method: "post" });
  };

  return (
    <s-page
      heading={`Rules for: ${catalogName}`}
      back-action-url="/app/catalog-manager"
    >
      <s-section heading="Hide Variant Types">
        <s-paragraph>
          These variant types are pulled live from your store. Tick the ones
          to hide from customers in this catalog.
        </s-paragraph>

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

        <div style={{ marginTop: "16px", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <s-button
            variant="secondary"
            onClick={() => navigate("/app/catalog-manager")}
          >
            Cancel
          </s-button>
          <s-button
            variant="primary"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? "Saving..." : "Save Rules"}
          </s-button>
        </div>
      </s-section>
    </s-page>
  );
}