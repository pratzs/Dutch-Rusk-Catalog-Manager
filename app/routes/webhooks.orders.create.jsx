// app/routes/webhooks.orders.create.jsx
//
// Fires on every new order. For B2B catalog orders where the customer pays a
// discounted catalog price, Shopify records NO discount_allocations — the lower
// price is simply baked in silently. This webhook enriches the order with
// explicit discount note_attributes so:
//   • The Shopify Admin order page shows the savings under "Additional Details"
//   • Any ERP (Ostendo, Odoo, etc.) reading the order via API sees the discount data
//
// How it works:
//   1. Receive order payload (REST format from Shopify webhook)
//   2. For every line item that has a variant, fetch the variant's compareAtPrice
//      (which equals the retail price — set by the "Sync Compare-At Prices" tool)
//   3. Compute savings per line: retailPrice − catalogPrice
//   4. Write the breakdown back to the order's note_attributes via orderUpdate mutation
//
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, admin, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Unhandled topic", { status: 200 });
  }

  const order = payload; // REST order object
  const lineItems = order.line_items ?? [];

  // Only process line items that have a Shopify variant attached
  const variantGids = lineItems
    .filter((li) => li.variant_id)
    .map((li) => `gid://shopify/ProductVariant/${li.variant_id}`);

  if (variantGids.length === 0) {
    return new Response("OK", { status: 200 });
  }

  try {
    // ── Step 1: Fetch retail price (compareAtPrice or metafield) for each variant ──
    const variantRes = await admin.graphql(
      `query GetVariantRetailPrices($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            sku
            title
            price
            compareAtPrice
            standardRetail: metafield(namespace: "custom", key: "standard_retail_price") {
              value
            }
          }
        }
      }`,
      { variables: { ids: variantGids } }
    );

    const { data } = await variantRes.json();

    // Build lookup: numeric variant ID → { price, compareAtPrice, standardRetail, sku, title }
    const variantMap = {};
    for (const node of data?.nodes ?? []) {
      if (node?.id) {
        const numId = node.id.split("/").pop();
        variantMap[numId] = node;
      }
    }

    // ── Step 2: Calculate savings and prepare data ───────────────────────────
    const fmt = (n) => `$${Math.abs(n).toFixed(2)}`;
    const discountNotes = [];
    let totalRetailValue = 0;
    let totalPaidValue = 0;

    for (const li of lineItems) {
      if (!li.variant_id) continue;

      const variant = variantMap[String(li.variant_id)];
      if (!variant) continue;

      // Prioritize the synced standard_retail_price metafield
      const retailPrice = parseFloat(
        variant.standardRetail?.value ?? variant.compareAtPrice ?? variant.price ?? "0"
      );
      const paidPrice = parseFloat(li.price ?? "0");
      const qty = parseInt(li.quantity ?? 1, 10);

      // Only note a discount if the customer actually paid less than retail
      if (retailPrice <= paidPrice || retailPrice <= 0 || paidPrice <= 0) continue;

      const savingPerUnit = retailPrice - paidPrice;
      const discountPct = ((savingPerUnit / retailPrice) * 100).toFixed(1);
      const lineSaving = savingPerUnit * qty;

      totalRetailValue += retailPrice * qty;
      totalPaidValue += paidPrice * qty;

      const label =
        li.sku ||
        [li.title, li.variant_title].filter(Boolean).join(" — ") ||
        `Variant ${li.variant_id}`;

      discountNotes.push({
        name: `B2B Discount — ${label}`,
        value: `${fmt(lineSaving)} saved (${discountPct}% off retail ${fmt(retailPrice)}/ea × ${qty})`,
      });
    }

    // Nothing to do — no B2B catalog discounts on this order
    if (discountNotes.length === 0) {
      return new Response("OK", { status: 200 });
    }

    const orderId = `gid://shopify/Order/${order.id}`;

    // ── Step 4: Trigger explicit orderEdit mutation for historical baseline ──
    const editBeginRes = await admin.graphql(
      `mutation BeginOrderEdit($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 50) {
              nodes {
                id
                variant { id }
              }
            }
          }
          userErrors { field message }
        }
      }`,
      { variables: { id: orderId } }
    );

    const editBeginData = await editBeginRes.json();
    if (editBeginData.errors) {
      console.error("[orders/create] orderEditBegin GraphQL errors:", JSON.stringify(editBeginData.errors));
    }

    const editId = editBeginData?.data?.orderEditBegin?.calculatedOrder?.id;
    const calcLines = editBeginData?.data?.orderEditBegin?.calculatedOrder?.lineItems?.nodes ?? [];
    const editUserErrors = editBeginData?.data?.orderEditBegin?.userErrors ?? [];

    if (editUserErrors.length > 0) {
      console.error("[orders/create] orderEditBegin userErrors:", JSON.stringify(editUserErrors));
    }

    if (editId) {
      // Map original variant IDs to their new CalculatedLineItem IDs
      for (const li of lineItems) {
        if (!li.variant_id) continue;
        const vGid = `gid://shopify/ProductVariant/${li.variant_id}`;
        const calcLi = calcLines.find(cl => cl.variant?.id === vGid);
        const variant = variantMap[String(li.variant_id)];

        if (calcLi && variant) {
          const retailPrice = parseFloat(variant.standardRetail?.value ?? variant.compareAtPrice ?? variant.price ?? "0");
          const paidPrice = parseFloat(li.price ?? "0");

          if (retailPrice > paidPrice) {
            const amount = (retailPrice - paidPrice).toFixed(2);
            const addDiscountRes = await admin.graphql(
              `mutation AddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
                orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  id: editId,
                  lineItemId: calcLi.id,
                  discount: {
                    fixedValue: {
                      amount,
                      currencyCode: "NZD"
                    },
                    description: "Wholesale Catalog Discount"
                  }
                }
              }
            );
            const addDiscountData = await addDiscountRes.json();
            const liUserErrors = addDiscountData?.data?.orderEditAddLineItemDiscount?.userErrors ?? [];
            if (liUserErrors.length > 0) {
              console.error(`[orders/create] orderEditAddLineItemDiscount userErrors for line ${li.id}:`, JSON.stringify(liUserErrors));
            }
          }
        }
      }

      // Commit the edit to solidify the historical baseline
      const commitRes = await admin.graphql(
        `mutation CommitOrderEdit($id: ID!) {
          orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Wholesale Catalog Discount Alignment") {
            userErrors { field message }
          }
        }`,
        { variables: { id: editId } }
      );
      const commitData = await commitRes.json();
      const commitUserErrors = commitData?.data?.orderEditCommit?.userErrors ?? [];
      if (commitUserErrors.length > 0) {
        console.error("[orders/create] orderEditCommit userErrors:", JSON.stringify(commitUserErrors));
      }
    }

    // ── Step 5: Update Order with note attributes ───────────────────────────
    const totalSaved = totalRetailValue - totalPaidValue;
    const overallPct = totalRetailValue > 0 ? ((totalSaved / totalRetailValue) * 100).toFixed(1) : "0.0";

    discountNotes.unshift({
      name: "B2B Total Savings",
      value: `${fmt(totalSaved)} saved — ${overallPct}% off retail (retail total: ${fmt(totalRetailValue)})`,
    });

    const existingNotes = (order.note_attributes ?? []).filter((n) => !String(n.name).startsWith("B2B "));
    const mergedNotes = [...existingNotes, ...discountNotes];

    const updateRes = await admin.graphql(
      `mutation UpdateOrderNotes($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id name }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            id: orderId,
            customAttributes: mergedNotes.map((n) => ({
              key: String(n.name),
              value: String(n.value),
            })),
          },
        },
      }
    );

    const updateData = await updateRes.json();
    const userErrors = updateData?.data?.orderUpdate?.userErrors ?? [];

    if (userErrors.length > 0) {
      console.error(`[orders/create] update errors for order ${order.id}:`, JSON.stringify(userErrors));
    } else {
      const orderName = updateData?.data?.orderUpdate?.order?.name ?? `#${order.order_number}`;
      console.log(`[orders/create] ${orderName}: completed orderEdit and wrote ${discountNotes.length} note(s).`);
    }
  } catch (err) {
    // Log but always return 200 — a non-200 causes Shopify to retry 19 times
    console.error(`[orders/create] Unhandled error for order ${order?.id}:`, err);
  }

  return new Response("OK", { status: 200 });
};
