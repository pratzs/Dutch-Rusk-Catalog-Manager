import { useLoaderData, useSubmit, useNavigation, useNavigate, useActionData } from "react-router";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// 1. BACKEND: Fetch available catalogs directly from Shopify
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  
  try {
    const response = await admin.graphql(`
      query {
        catalogs(first: 50) {
          nodes {
            id
            title
          }
        }
      }
    `);

    const data = await response.json();
    
    if (data.errors) {
      return { catalogs: [], debugError: JSON.stringify(data.errors) };
    }

    const shopifyCatalogs = data.data?.catalogs?.nodes || [];

    const formattedCatalogs = shopifyCatalogs.map(c => ({
      catalogId: c.id.split("/").pop(), 
      catalogName: c.title
    }));

    formattedCatalogs.sort((a, b) => a.catalogName.localeCompare(b.catalogName));

    return { catalogs: formattedCatalogs, debugError: null };
  } catch (error) {
    console.error("Failed to fetch catalogs for clone dropdown:", error);
    return { catalogs: [], debugError: error.message };
  }
}

// 2. BACKEND: The engine that duplicates the records
export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const sourceId = formData.get("sourceId");
  const targetId = formData.get("targetId");

  if (!sourceId || !targetId || sourceId === targetId) {
    return Response.json({ error: "Please select two different catalogs." }, { status: 400 });
  }

  try {
    const sourceOverrides = await prisma.productOverride.findMany({ where: { catalogId: sourceId } });
    const sourceRule = await prisma.catalogRule.findUnique({ where: { catalogId: sourceId } });

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

    if (sourceOverrides.length > 0) {
      await prisma.productOverride.deleteMany({ where: { catalogId: targetId } });

      const newOverrides = sourceOverrides.map(o => ({
        catalogId: targetId,
        productId: o.productId,
        hiddenVariantIds: o.hiddenVariantIds
      }));

      await prisma.productOverride.createMany({ data: newOverrides });
    }

    return { success: true, clonedCount: sourceOverrides.length };
  } catch (error) {
    console.error("Clone Error:", error);
    return Response.json({ error: "Failed to clone catalog rules." }, { status: 500 });
  }
}

// 3. FRONTEND: The User Interface
export default function CloneCatalog() {
  const { catalogs, debugError } = useLoaderData();
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

              {/* FOOLPROOF STANDARD DROPDOWNS */}
              <div style={{ marginTop: "16px", marginBottom: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <label style={{ fontWeight: "bold" }}>1. Copy rules FROM (Source)</label>
                <select 
                  value={source} 
                  onChange={(e) => setSource(e.target.value)}
                  style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc", width: "100%", height: "38px" }}
                >
                  <option value="">-- Select a catalog --</option>
                  {(catalogs || []).map(c => (
                    <option key={`source-${c.catalogId}`} value={c.catalogId}>
                      {c.catalogName}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: "24px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <label style={{ fontWeight: "bold" }}>2. Apply rules TO (Target)</label>
                <select 
                  value={target} 
                  onChange={(e) => setTarget(e.target.value)}
                  style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc", width: "100%", height: "38px" }}
                >
                  <option value="">-- Select a catalog --</option>
                  {(catalogs || []).map(c => (
                    <option key={`target-${c.catalogId}`} value={c.catalogId}>
                      {c.catalogName}
                    </option>
                  ))}
                </select>
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