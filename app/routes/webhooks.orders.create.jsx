// app/routes/webhooks.orders.create.jsx
//
// Fires on every new order. For B2B catalog orders where the customer pays a
// discounted catalog price, Shopify records NO discount_allocations — the lower
// price is simply baked in silently. This webhook enriches the order with
// explicit discount note_attributes and forcing native admin strikethroughs.
//

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  
  // ── Standard Webhook Authentication ──────────────────────────────────────
  const { topic, admin, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Unhandled topic", { status: 200 });
  }

  const order = payload; // REST order object
  const lineItems = order.line_items ?? [];

  // ── Mirror PO number / order note onto display metafields ────────────────
  // Runs unconditionally (before the B2B-discount early-returns below) so it
  // fires on every order regardless of whether it has catalog discounts.
  // Powers the "PO number" / "Order notes" Dynamic content blocks on the
  // customer account Order status page.
  try {
    const orderGid = `gid://shopify/Order/${order.id}`;
    const metafields = [];

    if (order.po_number) {
      metafields.push({
        ownerId: orderGid,
        namespace: "custom",
        key: "po_number_display",
        type: "single_line_text_field",
        value: String(order.po_number),
      });
    }

    if (order.note) {
      metafields.push({
        ownerId: orderGid,
        namespace: "custom",
        key: "notes_display",
        type: "single_line_text_field",
        value: String(order.note),
      });
    }

    if (metafields.length > 0) {
      const metaRes = await admin.graphql(
        `mutation SetOrderDisplayMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
        { variables: { metafields } }
      );
      const metaData = await metaRes.json();
      const metaErrors = metaData?.data?.metafieldsSet?.userErrors ?? [];
      if (metaErrors.length > 0) {
        console.error(`[orders/create] #${order.order_number}: metafieldsSet userErrors:`, metaErrors);
      }
    }
  } catch (metaErr) {
    console.error(`[orders/create] #${order?.order_number}: failed to mirror PO/notes metafields:`, metaErr);
  }

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
    console.log("[orders/create] Resolved variantMap:", JSON.stringify(variantMap, null, 2));

    // ── Step 2: Calculate savings and prepare data ───────────────────────────
    const fmt = (n) => `$${Math.abs(n).toFixed(2)}`;
    const discountNotes = [];
    let totalRetailValue = 0;
    let totalPaidValue = 0;

    for (const li of lineItems) {
      if (!li.variant_id) continue;

      const variant = variantMap[String(li.variant_id)];
      if (!variant) {
        console.warn(`[orders/create] Variant ${li.variant_id} not found in Shopify node lookup`);
        continue;
      }

      // Prioritize the synced standard_retail_price metafield
      const retailPrice = parseFloat(
        variant.standardRetail?.value ?? variant.compareAtPrice ?? variant.price ?? "0"
      );
      const paidPrice = parseFloat(li.price ?? "0");
      const qty = parseInt(li.quantity ?? 1, 10);

      console.log(`[orders/create] Comparing prices for line ${li.id}: Retail=${retailPrice}, Paid=${paidPrice}, Qty=${qty}`);

      // Only note a discount if the customer actually paid less than retail
      if (retailPrice <= paidPrice || retailPrice <= 0 || paidPrice <= 0) {
        console.log(`[orders/create] Skipping line ${li.id}: No discount detected (Retail <= Paid)`);
        continue;
      }

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

    // ── Step 4: Trigger explicit orderEdit mutation flow ────────────────────
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
    const editId = editBeginData?.data?.orderEditBegin?.calculatedOrder?.id;
    const calcLines = editBeginData?.data?.orderEditBegin?.calculatedOrder?.lineItems?.nodes ?? [];

    if (editId) {
      for (const li of lineItems) {
        if (!li.variant_id) continue;
        const vGid = `gid://shopify/ProductVariant/${li.variant_id}`;
        const calcLi = calcLines.find(cl => cl.variant?.id === vGid);
        const variant = variantMap[String(li.variant_id)];

        if (calcLi && variant) {
          const retailPrice = parseFloat(variant.standardRetail?.value ?? variant.compareAtPrice ?? variant.price ?? "0");
          const paidPrice = parseFloat(li.price ?? "0");
          const qty = parseInt(li.quantity ?? 1, 10);

          if (retailPrice > paidPrice) {
            console.log(`[orders/create] #${order.order_number}: Swapping line ${li.id} to force native strikethrough...`);

            // 1. Remove the old line item (set quantity to 0)
            await admin.graphql(
              `mutation RemoveOldLine($id: ID!, $lineItemId: ID!) {
                orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: 0) {
                  userErrors { field message }
                }
              }`,
              { variables: { id: editId, lineItemId: calcLi.id } }
            );

            // 2. Add the same variant back
            const addRes = await admin.graphql(
              `mutation AddNewLine($id: ID!, $variantId: ID!, $quantity: Int!) {
                orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
                  calculatedLineItem { id }
                  userErrors { field message }
                }
              }`,
              { variables: { id: editId, variantId: vGid, quantity: qty } }
            );
            const addData = await addRes.json();
            const newLineId = addData?.data?.orderEditAddVariant?.calculatedLineItem?.id;

            if (newLineId) {
              // 3. Apply the catalog discount markdown to the NEW line
              const amount = (retailPrice - paidPrice).toFixed(2);
              await admin.graphql(
                `mutation AddDiscountToNewLine($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
                  orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
                    userErrors { field message }
                  }
                }`,
                {
                  variables: {
                    id: editId,
                    lineItemId: newLineId,
                    discount: {
                      fixedValue: { amount: String(amount), currencyCode: "NZD" },
                      description: "Wholesale Catalog Discount"
                    }
                  }
                }
              );

              // 4. Record retail baseline as a visual property on the NEW line
              const existingProps = (li.properties ?? []).filter(p => p.name !== "Retail Price");
              await admin.graphql(
                `mutation SetNewLineProperties($id: ID!, $lineItemId: ID!, $input: OrderEditUpdateLineItemInput!) {
                  orderEditUpdateLineItem(id: $id, input: $input) {
                    userErrors { field message }
                  }
                }`,
                {
                  variables: {
                    id: newLineId,
                    input: {
                      customAttributes: [
                        ...existingProps.map(p => ({ key: p.name, value: String(p.value) })),
                        { key: "Retail Price", value: fmt(retailPrice) }
                      ]
                    }
                  }
                }
              );
            }
          }
        }
      }

      // Commit the edit
      await admin.graphql(
        `mutation CommitOrderEdit($id: ID!) {
          orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Wholesale Catalog Discount Swap") {
            userErrors { field message }
          }
        }`,
        { variables: { id: editId } }
      );
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

    await admin.graphql(
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

    const orderName = `#${order.order_number}`;
    console.log(`[orders/create] ${orderName}: swapped lines for native strikethrough and wrote ${discountNotes.length} note(s).`);
    
  } catch (err) {
    // Log but always return 200 — a non-200 causes Shopify to retry 19 times
    console.error(`[orders/create] Unhandled error for order ${order?.id}:`, err);
  }

  return new Response("OK", { status: 200 });
};
