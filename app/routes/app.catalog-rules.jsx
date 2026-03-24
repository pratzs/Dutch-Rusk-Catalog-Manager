import { redirect } from "react-router";
import { useLoaderData, useSubmit, useNavigate, useNavigation } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  let catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");
  if (!catalogId) return redirect("/app/catalog-manager");

  const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
  const rule = await prisma.catalogRule.findUnique({ where: { catalogId: cleanId } });

  // Simplified: only fetching Shipper, Bag, Block, etc.
  const variantTypes = ["Shipper", "Bag", "Block", "Packet", "Each", "Outer"];

  return {
    catalogId: cleanId,
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
    update: { hiddenVariantTypes, catalogName, hiddenVariantIds: [] },
    create: { catalogId, catalogName, hiddenVariantTypes, hiddenVariantIds: [] },
  });

  return redirect("/app/catalog-manager");
}

export default function CatalogRules() {
  const { catalogId, catalogName, hiddenVariantTypes } = useLoaderData();
  const [selected, setSelected] = useState(hiddenVariantTypes);
  const submit = useSubmit();
  const navigate = useNavigate();
  const isSaving = useNavigation().state === "submitting";

  const handleSave = () => {
    const formData = new FormData();
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    selected.forEach(v => formData.append("hiddenVariantTypes", v));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading={`Bulk Rules: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-section heading="Hide Variant Types">
        <s-stack direction="block" gap="tight">
          {["Shipper", "Bag", "Block", "Packet", "Each", "Outer"].map((type) => (
            <s-checkbox
              key={type}
              label={`Hide all "${type}" variants`}
              checked={selected.includes(type)}
              onInput={() => setSelected(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type])}
            />
          ))}
        </s-stack>
      </s-section>
      <div style={{ marginTop: "24px", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <s-button onClick={handleSave} variant="primary" disabled={isSaving}>Save</s-button>
      </div>
    </s-page>
  );
}