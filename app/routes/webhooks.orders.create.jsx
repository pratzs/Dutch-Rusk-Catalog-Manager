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
    // ── Step 1: Fetch retail price (compareAtPrice) for each variant ─────────
    const variantRes = await admin.graphql(
      `query GetVariantRetailPrices($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            sku
            title
            price
            compareAtPrice
          }
        }
      }`,
      { variables: { ids: variantGids } }
    );

    const { data } = await variantRes.json();

    // Build lookup: numeric variant ID → { price, compareAtPrice, sku, title }
    const variantMap = {};
    for (const node of data?.nodes ?? []) {
      if (node?.id) {
        const numId = node.id.split("/").pop();
        variantMap[numId] = node;
      }
    }

    // ── Step 2: Calculate discount per line item ──────────────────────────────
    const fmt = (n) => `$${Math.abs(n).toFixed(2)}`;
    const discountNotes = [];
    let totalRetailValue = 0;
    let totalPaidValue = 0;

    for (const li of lineItems) {
      if (!li.variant_id) continue;

      const variant = variantMap[String(li.variant_id)];
      if (!variant) continue;

      // compareAtPrice = retail price set by the sync tool
      // If compare_at was never set (no discount), fall back to price itself
      const retailPrice = parseFloat(variant.compareAtPrice ?? variant.price ?? "0");
      const paidPrice = parseFloat(li.price ?? "0");
      const qty = parseInt(li.quantity ?? 1, 10);

      // Only note a discount if the customer actually paid less than retail
      if (retailPrice <= paidPrice || retailPrice <= 0 || paidPrice <= 0) continue;

      const savingPerUnit = retailPrice - paidPrice;
      const discountPct = ((savingPerUnit / retailPrice) * 100).toFixed(1);
      const lineSaving = savingPerUnit * qty;

      totalRetailValue += retailPrice * qty;
      totalPaidValue += paidPrice * qty;

      // Use SKU if available, otherwise product title + variant title
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

    // ── Step 3: Prepend an order-level summary note ───────────────────────────
    const totalSaved = totalRetailValue - totalPaidValue;
    const overallPct =
      totalRetailValue > 0
        ? ((totalSaved / totalRetailValue) * 100).toFixed(1)
        : "0.0";

    discountNotes.unshift({
      name: "B2B Total Savings",
      value: `${fmt(totalSaved)} saved — ${overallPct}% off retail (retail total: ${fmt(totalRetailValue)})`,
    });

    // ── Step 4: Merge with any existing note_attributes and update order ──────
    // order.note_attributes is the REST payload field (uses "name" key)
    // Filter out any stale B2B notes from a previous run, keep everything else
    const existingNotes = (order.note_attributes ?? []).filter(
      (n) => !String(n.name).startsWith("B2B ")
    );
    // existingNotes use REST {name, value}; discountNotes use {name, value}
    // GraphQL customAttributes mutation uses {key, value} — convert on the way out
    const mergedNotes = [...existingNotes, ...discountNotes];

    const orderId = `gid://shopify/Order/${order.id}`;

    const updateRes = await admin.graphql(
      `mutation UpdateOrderDiscountNotes($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            name
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            id: orderId,
            // GraphQL uses "customAttributes" with {key, value} — not "noteAttributes"
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
      console.error(
        `[orders/create] orderUpdate errors for order ${order.id}:`,
        JSON.stringify(userErrors)
      );
    } else {
      const orderName = updateData?.data?.orderUpdate?.order?.name ?? `#${order.order_number}`;
      console.log(
        `[orders/create] ${orderName}: wrote ${discountNotes.length} B2B discount note(s). ` +
          `Total saved: ${fmt(totalSaved)} (${overallPct}% off retail)`
      );
    }
  } catch (err) {
    // Log but always return 200 — a non-200 causes Shopify to retry 19 times
    console.error(`[orders/create] Unhandled error for order ${order?.id}:`, err);
  }

  return new Response("OK", { status: 200 });
};
