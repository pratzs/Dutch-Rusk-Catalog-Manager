import { redirect } from "react-router";
import { useLoaderData, useSubmit, useNavigate, useNavigation } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

const VARIANT_TYPES = [
  { label: "Shipper", value: "Shipper" },
  { label: "Outer", value: "Outer" },
  { label: "Bag", value: "Bag" },
  { label: "Each", value: "Each" },
  { label: "Packet", value: "Packet" },
  { label: "Block", value: "Block" },
  { label: "Tray", value: "Tray" },
];

export async function loader({ request }) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");

  if (!catalogId) return redirect("/app/catalog-manager");

  const rule = await prisma.catalogRule.findUnique({
    where: { catalogId },
  });

  return {
    catalogId,
    catalogName,
    hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
  };
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const catalogId = formData.get("catalogId");
  const catalogName = formData.get("catalogName");
  const hiddenVariantTypes = formData.getAll("hiddenVariantTypes");

  await prisma.catalogRule.upsert({
    where: { catalogId },
    update: { hiddenVariantTypes, catalogName },
    create: { catalogId, catalogName, hiddenVariantTypes },
  });

  return redirect("/app/catalog-manager");
}

export default function CatalogRules() {
  const { catalogId, catalogName, hiddenVariantTypes } = useLoaderData();
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
          Tick the variant types to hide from customers in this catalog.
          For example, ticking "Shipper" will hide all Shipper variants
          (Shipper 6 Outer, Shipper 12 Outer, etc.)
        </s-paragraph>

        {VARIANT_TYPES.map((vt) => (
          <s-checkbox
            key={vt.value}
            label={`Hide all "${vt.label}" variants`}
            checked={selected.includes(vt.value)}
            onInput={() => handleToggle(vt.value)}
          />
        ))}

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

      <s-section slot="aside" heading="How this works">
        <s-paragraph>
          Rules apply to ALL products in this catalog. When a B2B customer
          logs in and is assigned to this catalog, the hidden variant types
          will not appear on any product page.
        </s-paragraph>
        <s-paragraph>
          Shipper variants include all sizes — Shipper 6 Outer,
          Shipper 12 Outer, Shipper 32 Outer, etc.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}