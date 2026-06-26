import { useLoaderData, useSubmit, useNavigation, useNavigate, useActionData } from "react-router";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const response = await admin.graphql(`
      query {
        catalogs(first: 250) {
          nodes { id title }
        }
      }
    `);

    const data = await response.json();
    if (data.errors) return { catalogs: [], error: JSON.stringify(data.errors) };

    const shopifyCatalogs = data.data?.catalogs?.nodes || [];
    const formatted = shopifyCatalogs
      .map((c) => ({ catalogId: c.id.split("/").pop(), catalogName: c.title }))
      .sort((a, b) => a.catalogName.localeCompare(b.catalogName));

    return { catalogs: formatted, error: null };
  } catch (err) {
    return { catalogs: [], error: err.message };
  }
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const sourceId = formData.get("sourceId");
  const targetId = formData.get("targetId");

  if (!sourceId || !targetId || sourceId === targetId) {
    return Response.json({ error: "Please select two different customer accounts." }, { status: 400 });
  }

  try {
    const [sourceOverrides, sourceRule] = await Promise.all([
      prisma.productOverride.findMany({ where: { catalogId: sourceId } }),
      prisma.catalogRule.findUnique({ where: { catalogId: sourceId } }),
    ]);

    await prisma.$transaction(async (tx) => {
      if (sourceRule) {
        await tx.catalogRule.upsert({
          where: { catalogId: targetId },
          update: {
            hiddenVariantTypes: sourceRule.hiddenVariantTypes,
            hiddenVariantIds: sourceRule.hiddenVariantIds,
          },
          create: {
            catalogId: targetId,
            catalogName: formData.get("targetName") || "Copied Catalog",
            hiddenVariantTypes: sourceRule.hiddenVariantTypes,
            hiddenVariantIds: sourceRule.hiddenVariantIds,
          },
        });
      }

      if (sourceOverrides.length > 0) {
        await tx.productOverride.deleteMany({ where: { catalogId: targetId } });
        await tx.productOverride.createMany({
          data: sourceOverrides.map((o) => ({
            catalogId: targetId,
            productId: o.productId,
            hiddenVariantIds: o.hiddenVariantIds,
          })),
        });
      }
    });

    return {
      success: true,
      clonedCount: sourceOverrides.length,
      sourceName: formData.get("sourceName") || "Source",
      targetName: formData.get("targetName") || "Target",
    };
  } catch (err) {
    console.error("Clone Error:", err);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export default function CloneCatalog() {
  const { catalogs, error: loaderError } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isCloning = navigation.state === "submitting";

  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show(
        `✅ Rules copied from "${actionData.sourceName}" to "${actionData.targetName}" successfully!`
      );
      setSource("");
      setTarget("");
    }
  }, [actionData]);

  const sourceName = catalogs.find((c) => c.catalogId === source)?.catalogName || "";
  const targetName = catalogs.find((c) => c.catalogId === target)?.catalogName || "";
  const readyToClone = source && target && source !== target;

  const handleClone = () => {
    if (!readyToClone) return;

    const formData = new FormData();
    formData.append("sourceId", source);
    formData.append("targetId", target);
    formData.append("sourceName", sourceName);
    formData.append("targetName", targetName);
    submit(formData, { method: "post" });
  };

  const selectStyle = {
    padding: '10px 12px',
    borderRadius: '6px',
    border: '1px solid #c9cccf',
    width: '100%',
    fontSize: '14px',
    background: '#fff',
    appearance: 'auto',
  };

  return (
    <s-page heading="Copy Rules to Another Customer" back-action-url="/app/catalog-manager">

      <s-section heading="What does this do?">
        <s-text>
          This tool copies <b>all pack type rules and product exceptions</b> from one customer
          account to another — saving you from having to set them up manually.
        </s-text>
        <div style={{ marginTop: '6px', padding: '10px 12px', background: '#fff4f4', border: '1px solid #ffd2d2', borderRadius: '6px' }}>
          <s-text fontWeight="bold" color="critical">
            Warning: This will replace any existing rules on the destination account.
          </s-text>
        </div>
      </s-section>

      <s-section heading="Copy Rules">
        {loaderError && (
          <div style={{ padding: '12px', background: '#fff4f4', border: '1px solid #ffd2d2', borderRadius: '6px', marginBottom: '16px', color: '#d72c0d' }}>
            <b>Could not load catalogs:</b> {loaderError}
          </div>
        )}

        {actionData?.error && (
          <div style={{ padding: '12px', background: '#fff4f4', border: '1px solid #ffd2d2', borderRadius: '6px', marginBottom: '16px', color: '#d72c0d' }}>
            <b>Error:</b> {actionData.error}
          </div>
        )}

        {actionData?.success && (
          <div style={{ padding: '16px', background: '#f1f8f5', border: '1px solid #95c9b4', borderRadius: '6px', marginBottom: '16px' }}>
            <div style={{ fontWeight: '700', color: '#008060', marginBottom: '4px' }}>Rules copied successfully!</div>
            <div style={{ fontSize: '14px', color: '#006e52' }}>
              Copied rules from <b>{actionData.sourceName}</b> to <b>{actionData.targetName}</b>
              {actionData.clonedCount > 0 && ` — including ${actionData.clonedCount} product exception(s).`}
            </div>
          </div>
        )}

        <s-block-stack gap="base">
          <div>
            <div style={{ fontWeight: '700', fontSize: '15px', marginBottom: '8px' }}>
              Step 1 — Copy rules FROM this account:
            </div>
            <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle}>
              <option value="">— Select source customer account —</option>
              {catalogs.map((c) => (
                <option key={`src-${c.catalogId}`} value={c.catalogId}>
                  {c.catalogName}
                </option>
              ))}
            </select>
          </div>

          <div style={{ textAlign: 'center', fontSize: '24px', color: '#6d7175' }}>⬇</div>

          <div>
            <div style={{ fontWeight: '700', fontSize: '15px', marginBottom: '8px' }}>
              Step 2 — Apply rules TO this account:
            </div>
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
              <option value="">— Select destination customer account —</option>
              {catalogs
                .filter((c) => c.catalogId !== source)
                .map((c) => (
                  <option key={`tgt-${c.catalogId}`} value={c.catalogId}>
                    {c.catalogName}
                  </option>
                ))}
            </select>
          </div>

          {readyToClone && (
            <div style={{
              padding: '14px 16px',
              background: '#f6f6f7',
              borderRadius: '6px',
              border: '1px solid #e1e3e5',
              fontSize: '14px',
              lineHeight: '1.6',
            }}>
              <b>You are about to copy:</b><br />
              All rules from <span style={{ color: '#008060', fontWeight: '600' }}>{sourceName}</span>{" "}
              → <span style={{ color: '#d72c0d', fontWeight: '600' }}>{targetName}</span>.<br />
              <span style={{ color: '#6d7175' }}>Any existing rules on <b>{targetName}</b> will be permanently replaced.</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: '12px', paddingTop: '4px' }}>
            <s-button
              variant="primary"
              tone="critical"
              onClick={handleClone}
              disabled={isCloning || !readyToClone}
            >
              {isCloning ? "Copying..." : "Copy Rules Now"}
            </s-button>
            <s-button onClick={() => navigate("/app/catalog-manager")}>
              Cancel
            </s-button>
          </div>
        </s-block-stack>
      </s-section>

    </s-page>
  );
}
