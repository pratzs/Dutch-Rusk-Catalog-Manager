// app/routes/app.activate-pricing.jsx
import { useActionData, useLoaderData, Form } from "react-router";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(`query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`);
  const data = await response.json();
  const targetFunction = data.data.shopifyFunctions.nodes.find(f => f.title === "b2b-custom-prices");

  const discountsRes = await admin.graphql(`query { discountNodes(first: 50) { nodes { id discount { __typename ... on DiscountAutomaticApp { title combinesWith { productDiscounts } } } } } }`);
  const discountsData = await discountsRes.json();
  const liveDiscount = discountsData.data?.discountNodes?.nodes?.find(
    (n) => n.discount?.__typename === "DiscountAutomaticApp" && n.discount.title === "B2B Wholesale Custom Pricing"
  );

  return {
    functionId: targetFunction?.id ?? null,
    liveDiscountId: liveDiscount?.id ?? null,
    combinesWithProductDiscounts: liveDiscount?.discount?.combinesWith?.productDiscounts ?? null,
  };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "allow_combine") {
    const discountId = formData.get("discountId");
    if (!discountId) return { error: "Discount ID not found" };
    try {
      const response = await admin.graphql(`mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) { discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) { automaticAppDiscount { combinesWith { productDiscounts } } userErrors { field message } } }`, {
        variables: { id: discountId, automaticAppDiscount: { combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: false } } }
      });
      const data = await response.json();
      const userErrors = data.data?.discountAutomaticAppUpdate?.userErrors ?? [];
      if (data.errors || userErrors.length > 0) return { error: userErrors.map(e => e.message).join(", ") || "GraphQL error" };
      return { combineSuccess: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  const functionId = formData.get("functionId");
  if (!functionId) return { error: "Function ID not found" };

  try {
    const response = await admin.graphql(`mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) { discountCreate: discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) { automaticAppDiscount { discountId } userErrors { field message } } }`, {
      variables: { automaticAppDiscount: { title: "B2B Wholesale Custom Pricing", functionId, discountClasses: ["PRODUCT"], startsAt: new Date().toISOString() } }
    });
    const data = await response.json();
    const userErrors = data.data?.discountCreate?.userErrors ?? [];
    if (data.errors || userErrors.length > 0) return { error: userErrors.map(e => e.message).join(", ") || "GraphQL error" };
    return { success: true, discountId: data.data.discountCreate.automaticAppDiscount.discountId };
  } catch (err) {
    return { error: err.message };
  }
}

export default function ActivatePricing() {
  const { functionId, liveDiscountId, combinesWithProductDiscounts } = useLoaderData();
  const actionData = useActionData();
  return (
    <s-page heading="Activate B2B Custom Pricing">
      <s-layout><s-layout-section><s-box padding="base" background="bg-surface-secondary" borderRadius="base">
        <s-block-stack gap="base">
          <s-text variant="headingMd" as="h2">Enable Custom Pricing Logic</s-text>
          <s-text>Click below to register the <b>b2b-custom-prices</b> function.</s-text>
          {!functionId ? (
            <s-box padding="base" background="bg-critical" borderRadius="base"><s-text color="critical">Extension not found.</s-text></s-box>
          ) : (
            <Form method="post"><input type="hidden" name="functionId" value={functionId} /><s-button variant="primary" type="submit">Activate B2B Pricing Function</s-button></Form>
          )}
          {actionData?.success && <s-box padding="base" background="bg-success" borderRadius="base"><s-text color="success">Activated! ID: {actionData.discountId}</s-text></s-box>}
          {actionData?.error && <s-box padding="base" background="bg-critical" borderRadius="base"><s-text color="critical">Error: {actionData.error}</s-text></s-box>}
        </s-block-stack>
      </s-box></s-layout-section></s-layout>
      <s-layout><s-layout-section><s-box padding="base" background="bg-surface-secondary" borderRadius="base">
        <s-block-stack gap="base">
          <s-text variant="headingMd" as="h2">Allow combining with other product discounts</s-text>
          <s-text>
            Currently set to <b>{combinesWithProductDiscounts === null ? "unknown" : combinesWithProductDiscounts ? "true" : "false"}</b>.
            Needed so BOGO Bundles can stack with wholesale pricing on the same line. Only this one flag changes -- it still won&apos;t combine with anything else.
          </s-text>
          {!liveDiscountId ? (
            <s-box padding="base" background="bg-critical" borderRadius="base"><s-text color="critical">Live discount not found -- activate it above first.</s-text></s-box>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="allow_combine" />
              <input type="hidden" name="discountId" value={liveDiscountId} />
              <s-button variant="primary" type="submit">Set combinesWith.productDiscounts = true</s-button>
            </Form>
          )}
          {actionData?.combineSuccess && <s-box padding="base" background="bg-success" borderRadius="base"><s-text color="success">Updated.</s-text></s-box>}
        </s-block-stack>
      </s-box></s-layout-section></s-layout>
    </s-page>
  );
}
