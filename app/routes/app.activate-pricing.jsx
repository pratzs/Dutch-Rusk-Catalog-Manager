import { useActionData, useLoaderData, Form } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  // ── Step 1: Query for the b2b-custom-prices function details ──────────────
  const response = await admin.graphql(`
    query {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          handle
          apiType
        }
      }
    }
  `);

  const data = await response.json();
  const functions = data.data.shopifyFunctions.nodes;

  // Find our specific function by title
  const targetFunction = functions.find(f => f.title === "b2b-custom-prices");

  return { functionHandle: targetFunction?.handle ?? null };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const functionHandle = formData.get("functionHandle");

  if (!functionHandle) {
    return { error: "Function Handle not found. Ensure the extension is deployed." };
  }

  // ── Step 2: Create the Automatic Discount (using functionHandle + discountClasses) ─
  try {
    const response = await admin.graphql(`
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountCreate: discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        automaticAppDiscount: {
          title: "B2B Wholesale Custom Pricing",
          functionHandle,
          discountClasses: ["PRODUCT"],
          startsAt: new Date().toISOString(),
        }
      }
    });

    const data = await response.json();
    const userErrors = data.data?.discountCreate?.userErrors ?? [];

    if (data.errors || userErrors.length > 0) {
      console.log("Full GraphQL Response Errors:", JSON.stringify(data.errors || data.data?.discountCreate?.userErrors, null, 2));
      if (userErrors.length > 0) {
        return { error: userErrors.map(e => e.message).join(", ") };
      }
      return { error: "An unexpected GraphQL error occurred." };
    }

    return { success: true, discountId: data.data.discountCreate.automaticAppDiscount.discountId };
  } catch (err) {
    console.error("Discount Activation Exception:", err);
    if (err.response) {
      const errorData = await err.response.json().catch(() => ({}));
      console.error("Full GraphQL Error Response:", JSON.stringify(errorData, null, 2));
      return { error: `GraphQL Error: ${JSON.stringify(errorData.errors || "Unknown error")}` };
    }
    return { error: `Activation Failed: ${err.message}` };
  }
}

export default function ActivatePricing() {
  const { functionHandle } = useLoaderData();
  const actionData = useActionData();

  return (
    <s-page heading="Activate B2B Custom Pricing">
      <s-layout>
        <s-layout-section>
          <s-box padding="base" background="bg-surface-secondary" borderRadius="base">
            <s-block-stack gap="base">
              <s-text variant="headingMd" as="h2">Enable Custom Pricing Logic</s-text>
              <s-text>
                Click the button below to register the <b>b2b-custom-prices</b> function as an automatic discount in your store. 
                This will enable specialized wholesale pricing for your B2B customers based on your catalog overrides.
              </s-text>

              {!functionHandle ? (
                <s-box padding="base" background="bg-critical" borderRadius="base">
                  <s-text color="critical">
                    Error: The "b2b-custom-prices" extension was not found. Please ensure it has been deployed using "shopify app deploy".
                  </s-text>
                </s-box>
              ) : (
                <Form method="post">
                  <input type="hidden" name="functionHandle" value={functionHandle} />
                  <s-button variant="primary" type="submit">
                    Activate B2B Pricing Function
                  </s-button>
                </Form>
              )}

              {actionData?.success && (
                <s-box padding="base" background="bg-success" borderRadius="base">
                  <s-text color="success">
                    Successfully activated! Discount ID: {actionData.discountId}
                  </s-text>
                </s-box>
              )}

              {actionData?.error && (
                <s-box padding="base" background="bg-critical" borderRadius="base">
                  <s-text color="critical">
                    Error: {actionData.error}
                  </s-text>
                </s-box>
              )}
            </s-block-stack>
          </s-box>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
