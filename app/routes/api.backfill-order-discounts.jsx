// app/routes/api.backfill-order-discounts.jsx

const PAGE_SIZE = 25;

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin } = await authenticate.admin(request);

  const body = await request.json().catch(() => ({}));
  const cursor = body.cursor ?? null;
  const daysBack = body.daysBack ?? 365;

  let updatedCount = 0;
  let skippedCount = 0;

  try {
    const createdAtFilter =
      daysBack > 0
        ? `created_at:>='${new Date(Date.now() - daysBack * 86400 * 1000).toISOString()}'`
        : null;

    const ordersRes = await admin.graphql(
      `query GetOrders($cursor: String, $query: String) {
        orders(first: ${PAGE_SIZE}, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            name
            customAttributes { key value }
            lineItems(first: 100) {
              nodes {
                quantity
                originalUnitPriceSet {
                  shopMoney { amount currencyCode }
                }
                variant {
                  id
                  sku
                  title
                  price
                  compareAtPrice
                  product { title }
                }
              }
            }
          }
        }
      }`,
      { variables: { cursor, query: createdAtFilter ?? "" } }
    );

    const { data, errors } = await ordersRes.json();
    if (errors) return Response.json({ error: "Query failed" }, { status: 500 });

    const page = data?.orders;
    if (!page) return Response.json({ success: true, updatedCount: 0, skippedCount: 0, done: true });

    await Promise.all(
      page.nodes.map(async (order) => {
        const fmt = (n) => `$${Math.abs(n).toFixed(2)}`;
        const discountNotes = [];
        let totalRetailValue = 0;
        let totalPaidValue = 0;

        for (const li of order.lineItems?.nodes ?? []) {
          const variant = li.variant;
          if (!variant) continue;
          const retailPrice = parseFloat(variant.compareAtPrice ?? variant.price ?? "0");
          const paidPrice = parseFloat(li.originalUnitPriceSet?.shopMoney?.amount ?? variant.price ?? "0");
          const qty = parseInt(li.quantity ?? 1, 10);
          if (retailPrice <= paidPrice || retailPrice <= 0 || paidPrice <= 0) continue;
          const savingPerUnit = retailPrice - paidPrice;
          const discountPct = ((savingPerUnit / retailPrice) * 100).toFixed(1);
          const lineSaving = savingPerUnit * qty;
          totalRetailValue += retailPrice * qty;
          totalPaidValue += paidPrice * qty;
          const label = li.sku || [variant.product?.title, variant.title].filter(Boolean).join(" — ") || variant.id.split("/").pop();
          discountNotes.push({ name: `B2B Discount — ${label}`, value: `${fmt(lineSaving)} saved (${discountPct}% off retail ${fmt(retailPrice)}/ea × ${qty})` });
        }

        if (discountNotes.length === 0) { skippedCount++; return; }
        const totalSaved = totalRetailValue - totalPaidValue;
        const overallPct = totalRetailValue > 0 ? ((totalSaved / totalRetailValue) * 100).toFixed(1) : "0.0";
        discountNotes.unshift({ name: "B2B Total Savings", value: `${fmt(totalSaved)} saved — ${overallPct}% off retail (retail total: ${fmt(totalRetailValue)})` });

        const existingNotes = (order.customAttributes ?? []).filter((n) => !String(n.key).startsWith("B2B "));
        const mergedNotes = [...existingNotes.map((n) => ({ key: n.key, value: n.value })), ...discountNotes.map((n) => ({ key: n.name, value: n.value }))];

        await admin.graphql(`mutation UpdateOrderDiscountNotes($input: OrderInput!) { orderUpdate(input: $input) { order { id name } userErrors { field message } } }`, {
          variables: { input: { id: order.id, customAttributes: mergedNotes } }
        });
        updatedCount++;
      })
    );

    return Response.json({ success: true, updatedCount, skippedCount, done: !page.pageInfo.hasNextPage, nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
