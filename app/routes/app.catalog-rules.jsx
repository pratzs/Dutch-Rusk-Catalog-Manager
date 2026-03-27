import { redirect } from "react-router";
import { useLoaderData, useSubmit, useNavigate, useNavigation } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PACK_TYPES = [
  { value: "Shipper",  label: "Shipper",  description: "Large shipping cases, typically sold to distributors" },
  { value: "Bag",      label: "Bag",      description: "Bag format pack sizes" },
  { value: "Block",    label: "Block",    description: "Block format packaging" },
  { value: "Packet",   label: "Packet",   description: "Smaller packet format" },
  { value: "Each",     label: "Each",     description: "Individual single-unit items" },
  { value: "Outer",    label: "Outer",    description: "Outer carton cases" },
];

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");
  if (!catalogId) return redirect("/app/catalog-manager");

  const cleanId = catalogId.includes("/") ? catalogId.split("/").pop() : catalogId;
  const rule = await prisma.catalogRule.findUnique({ where: { catalogId: cleanId } });

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
    update: { hiddenVariantTypes, catalogName },
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

  const toggleType = (type) => {
    setSelected((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    selected.forEach((v) => formData.append("hiddenVariantTypes", v));
    submit(formData, { method: "post" });
  };

  const noneSelected = selected.length === 0;
  const allSelected = selected.length === PACK_TYPES.length;

  return (
    <s-page heading={`Pack Type Rules: ${catalogName}`} back-action-url="/app/catalog-manager">
      <s-layout>
        <s-layout-section>

          {/* Instructions */}
          <s-box padding="base" background="bg-surface-secondary" borderRadius="base"
            style={{ marginBottom: '20px', border: '1px solid #e1e3e5' }}>
            <s-block-stack gap="tight">
              <s-text variant="headingMd" as="h2">🚫 Blanket Pack Type Rules</s-text>
              <s-text>
                Tick the box next to any pack type to <b>hide it entirely</b> for this customer account.
                Every product of that type will be hidden — no exceptions.
              </s-text>
              <div style={{ marginTop: '6px', padding: '10px 12px', background: '#f1f8f5', border: '1px solid #95c9b4', borderRadius: '6px' }}>
                <s-text color="success">
                  💡 <b>Tip:</b> Use "Product Overrides" on the previous page if you need to make
                  exceptions for specific products.
                </s-text>
              </div>
            </s-block-stack>
          </s-box>

          {/* Status summary */}
          <div style={{ marginBottom: '16px', padding: '12px 16px', background: noneSelected ? '#f1f8f5' : '#fff4f4', border: `1px solid ${noneSelected ? '#95c9b4' : '#ffd2d2'}`, borderRadius: '8px' }}>
            {noneSelected ? (
              <s-text color="success">✅ <b>No pack types blocked</b> — this customer can see all pack sizes.</s-text>
            ) : allSelected ? (
              <s-text color="critical">🚫 <b>All pack types blocked</b> — this customer cannot see any products.</s-text>
            ) : (
              <s-text color="critical">
                🚫 <b>Blocking {selected.length} pack type{selected.length !== 1 ? 's' : ''}:</b>{" "}
                {selected.join(", ")}
              </s-text>
            )}
          </div>

          {/* Pack type checkboxes */}
          <s-box padding="base" borderWidth="base" borderRadius="base" background="surface">
            <s-stack direction="block" gap="base">
              {PACK_TYPES.map(({ value, label, description }) => {
                const isBlocked = selected.includes(value);
                return (
                  <div
                    key={value}
                    onClick={() => toggleType(value)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '14px',
                      padding: '14px 16px',
                      border: `1px solid ${isBlocked ? '#d72c0d' : '#e1e3e5'}`,
                      borderRadius: '8px',
                      background: isBlocked ? '#fff4f4' : '#fafbfb',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <s-checkbox
                      label=""
                      checked={isBlocked}
                      onInput={() => toggleType(value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: '700', fontSize: '15px', color: isBlocked ? '#d72c0d' : '#1a1a2e' }}>
                        {isBlocked ? '🚫 ' : ''}{label}
                      </div>
                      <div style={{ fontSize: '13px', color: '#6d7175', marginTop: '2px' }}>
                        {description}
                      </div>
                    </div>
                    {isBlocked && (
                      <span style={{ fontSize: '12px', background: '#d72c0d', color: '#fff', padding: '3px 10px', borderRadius: '12px', fontWeight: '600', whiteSpace: 'nowrap' }}>
                        Hidden
                      </span>
                    )}
                  </div>
                );
              })}
            </s-stack>
          </s-box>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '20px' }}>
            <s-button onClick={() => navigate("/app/catalog-manager")}>Cancel</s-button>
            <s-button variant="primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Rules"}
            </s-button>
          </div>

        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
