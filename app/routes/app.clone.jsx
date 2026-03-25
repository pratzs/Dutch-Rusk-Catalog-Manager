import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useNavigate, useActionData } from "@remix-run/react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// 1. BACKEND: Fetch available catalogs from your database
export async function loader({ request }) {
  await authenticate.admin(request);
  
  // We fetch catalogs that the app already knows about
  const savedCatalogs = await prisma.catalogRule.findMany({
    select: { catalogId: true, catalogName: true },
    orderBy: { catalogName: 'asc' }
  });

  return json({ catalogs: savedCatalogs });
}

// 2. BACKEND: The engine that duplicates the records
export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const sourceId = formData.get("sourceId");
  const targetId = formData.get("targetId");

  if (!sourceId || !targetId || sourceId === targetId) {
    return json({ error: "Please select two different catalogs." }, { status: 400 });
  }

  try {
    // A. Get the rules we want to copy
    const sourceOverrides = await prisma.productOverride.findMany({ where: { catalogId: sourceId } });
    const sourceRule = await prisma.catalogRule.findUnique({ where: { catalogId: sourceId } });

    // B. Copy the Bulk Rules (The Tags)
    if (sourceRule) {
      await prisma.catalogRule.upsert({
        where: { catalogId: targetId },
        update: {
          hiddenVariantTypes: sourceRule.hiddenVariantTypes,
          hiddenVariantIds: sourceRule.hiddenVariantIds
        },
        create: {
          catalogId: targetId,
          catalogName: formData.get("targetName") || "Updated Catalog",
          hiddenVariantTypes: sourceRule.hiddenVariantTypes,
          hiddenVariantIds: sourceRule.hiddenVariantIds
        }
      });
    }

    // C. Copy the Specific Product Exceptions (The Red Boxes)
    if (sourceOverrides.length > 0) {
      // Wipe the target clean first so we don't mix old and new rules
      await prisma.productOverride.deleteMany({ where: { catalogId: targetId } });

      const newOverrides = sourceOverrides.map(o => ({
        catalogId: targetId,
        productId: o.productId,
        hiddenVariantIds: o.hiddenVariantIds
      }));

      // Insert the cloned data
      await prisma.productOverride.createMany({ data: newOverrides });
    }

    return json({ success: true, clonedCount: sourceOverrides.length });
  } catch (error) {
    console.error("Clone Error:", error);
    return json({ error: "Failed to clone catalog rules." }, { status: 500 });
  }
}

// 3. FRONTEND: The User Interface
export default function CloneCatalog() {
  const { catalogs } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isCloning = navigation.state === "submitting";

  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show("Catalog successfully cloned!");
      // Optionally reset form
      setSource("");
      setTarget("");
    }
  }, [actionData]);

  const handleClone = () => {
    if (!source || !target) {
      shopify.toast.show("Please select both a source and a target.", { isError: true });
      return;
    }
    
    const targetName = catalogs.find(c => c.catalogId === target)?.catalogName || "Cloned Catalog";

    const formData = new FormData();
    formData.append("sourceId", source);
    formData.append("targetId", target);
    formData.append("targetName", targetName);
    
    submit(formData, { method: "post" });
  };

  // Convert DB catalogs into Shopify Dropdown options
  const catalogOptions = [
    { label: "Select a catalog...", value: "" },
    ...catalogs.map(c => ({ label: c.catalogName, value: c.catalogId }))
  ];

  return (
    <s-page heading="Clone Catalog Rules" back-action-url="/app/catalog-manager">
      <s-layout>
        <s-layout-section>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="surface">
            <s-block-stack gap="base">
              <s-text variant="headingMd" as="h2">Duplicate Visibility Rules</s-text>
              <s-text color="subdued">
                Instantly copy all bulk rules and specific product exceptions from an existing setup to another catalog. 
                Warning: This will overwrite any existing rules on the target catalog.
              </s-text>

              {actionData?.error && (
                <s-banner tone="critical">{actionData.error}</s-banner>
              )}

              {actionData?.success && (
                <s-banner tone="success">
                  Successfully cloned {actionData.clonedCount} product exceptions!
                </s-banner>
              )}

              <div style={{ marginTop: "16px", marginBottom: "16px" }}>
                <s-select 
                  label="1. Copy rules FROM (Source)" 
                  options={catalogOptions} 
                  value={source} 
                  onChange={setSource} 
                />
              </div>

              <div style={{ marginBottom: "24px" }}>
                <s-select 
                  label="2. Apply rules TO (Target)" 
                  options={catalogOptions} 
                  value={target} 
                  onChange={setTarget} 
                />
              </div>

              <s-stack direction="inline" gap="base">
                <s-button 
                  variant="primary" 
                  tone="critical" 
                  onClick={handleClone} 
                  disabled={isCloning || !source || !target || source === target}
                >
                  {isCloning ? "Cloning..." : "Clone Catalog"}
                </s-button>
                <s-button onClick={() => navigate("/app/catalog-manager")}>
                  Cancel
                </s-button>
              </s-stack>
            </s-block-stack>
          </s-box>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}