// app/routes/webhooks.orders.updated.jsx
//
// Fires whenever an existing order is edited. Keeps the PO number / order
// note display metafields in sync if either is added or changed after the
// order was first created (orders/create only captures it at creation time).

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");

  const { topic, admin, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_UPDATED") {
    return new Response("Unhandled topic", { status: 200 });
  }

  const order = payload; // REST order object

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
        console.error(`[orders/updated] #${order.order_number}: metafieldsSet userErrors:`, metaErrors);
      }
    }
  } catch (metaErr) {
    console.error(`[orders/updated] #${order?.order_number}: failed to mirror PO/notes metafields:`, metaErr);
  }

  return new Response("OK", { status: 200 });
};
