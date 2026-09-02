// app/routes/app.activate-bogo.jsx
import { useActionData, useLoaderData, Form } from "react-router";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(`query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`);
  const data = await response.json();
  const targetFunction = data.data.shopifyFunctions.nodes.find(f => f.title === "BOGO Bundles");
  return { functionId: targetFunction?.id ?? null };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const functionId = formData.get("functionId");
  if (!functionId) return { error: "Function ID not found" };

  try {
    const response = await admin.graphql(`mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) { discountCreate: discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) { automaticAppDiscount { discountId } userErrors { field message } } }`, {
      variables: { automaticAppDiscount: { title: "BOGO Bundles", functionId, discountClasses: ["PRODUCT"], startsAt: new Date().toISOString(), combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false } } }
    });
    const data = await response.json();
    const userErrors = data.data?.discountCreate?.userErrors ?? [];
    if (data.errors || userErrors.length > 0) return { error: userErrors.map(e => e.message).join(", ") || "GraphQL error" };
    return { success: true, discountId: data.data.discountCreate.automaticAppDiscount.discountId };
  } catch (err) {
    return { error: err.message };
  }
}

export default function ActivateBogo() {
  const { functionId } = useLoaderData();
  const actionData = useActionData();
  return (
    <s-page heading="Activate BOGO Bundles">
      <s-layout><s-layout-section><s-box padding="base" background="bg-surface-secondary" borderRadius="base">
        <s-block-stack gap="base">
          <s-text variant="headingMd" as="h2">Enable Buy-X-Get-Y Bundle Deals</s-text>
          <s-text>Click below to register the <b>bogo-bundles</b> function as a live automatic discount. Deals themselves are edited via Settings → Custom data → Shop metafields → BOGO Bundles.</s-text>
          {!functionId ? (
            <s-box padding="base" background="bg-critical" borderRadius="base"><s-text color="critical">Extension not found. Deploy the app first (shopify app deploy).</s-text></s-box>
          ) : (
            <Form method="post"><input type="hidden" name="functionId" value={functionId} /><s-button variant="primary" type="submit">Activate BOGO Bundles Function</s-button></Form>
          )}
          {actionData?.success && <s-box padding="base" background="bg-success" borderRadius="base"><s-text color="success">Activated! ID: {actionData.discountId}</s-text></s-box>}
          {actionData?.error && <s-box padding="base" background="bg-critical" borderRadius="base"><s-text color="critical">Error: {actionData.error}</s-text></s-box>}
        </s-block-stack>
      </s-box></s-layout-section></s-layout>
    </s-page>
  );
}
