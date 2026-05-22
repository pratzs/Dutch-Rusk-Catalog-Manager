import { useActionData, useLoaderData, Form } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  // ── Step 1: Query for the b2b-price-transformer function details ──────────
  const response = await admin.graphql(`
    query {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          apiType
        }
      }
    }
  `);

  const data = await response.json();
  const functions = data.data.shopifyFunctions.nodes;

  const targetFunction = functions.find(f => f.title === "b2b-price-transformer");

  return { functionId: targetFunction?.id ?? null };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const functionId = formData.get("functionId");

  if (!functionId) {
    return { error: "Function ID not found. Ensure the extension is deployed." };
  }

  // ── Step 2: Create the Cart Transform ──────────────────────────────────────
  try {
    const response = await admin.graphql(`
      mutation cartTransformCreate($functionId: ID!) {
        cartTransformCreate(functionId: $functionId) {
          cartTransform {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        functionId
      }
    });

    const data = await response.json();
    const userErrors = data.data?.cartTransformCreate?.userErrors ?? [];

    if (data.errors || userErrors.length > 0) {
      console.log("Full GraphQL Response Errors:", JSON.stringify(data.errors || data.data?.cartTransformCreate?.userErrors, null, 2));
      if (userErrors.length > 0) {
        return { error: userErrors.map(e => e.message).join(", ") };
      }
      return { error: "An unexpected GraphQL error occurred." };
    }

    return { success: true, transformId: data.data.cartTransformCreate.cartTransform.id };
  } catch (err) {
    console.error("Cart Transform Activation Exception:", err);
    return { error: `Activation Failed: ${err.message}` };
  }
}

export default function ActivateTransformer() {
  const { functionId } = useLoaderData();
  const actionData = useActionData();

  return (
    <s-page heading="Activate B2B Price Transformer">
      <s-layout>
        <s-layout-section>
          <s-box padding="base" background="bg-surface-secondary" borderRadius="base">
            <s-block-stack gap="base">
              <s-text variant="headingMd" as="h2">Enable Native Price Overrides</s-text>
              <s-text>
                Click the button below to register the <b>b2b-price-transformer</b> function. 
                This will allow your store to natively override cart line prices and display retail strikethroughs ($~~Retail~~$ $Wholesale) in the checkout.
              </s-text>

              {!functionId ? (
                <s-box padding="base" background="bg-critical" borderRadius="base">
                  <s-text color="critical">
                    Error: The "b2b-price-transformer" extension was not found. Please ensure it has been deployed.
                  </s-text>
                </s-box>
              ) : (
                <Form method="post">
                  <input type="hidden" name="functionId" value={functionId} />
                  <s-button variant="primary" type="submit">
                    Activate B2B Transformer Function
                  </s-button>
                </Form>
              )}

              {actionData?.success && (
                <s-box padding="base" background="bg-success" borderRadius="base">
                  <s-text color="success">
                    Successfully activated! Transform ID: {actionData.transformId}
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
