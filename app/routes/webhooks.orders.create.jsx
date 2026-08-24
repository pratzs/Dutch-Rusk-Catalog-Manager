// app/routes/webhooks.orders.create.jsx
//
// Fires on every new order. For B2B catalog orders where the customer pays a
// discounted catalog price, Shopify records NO discount_allocations — the lower
// price is simply baked in silently, with no reference anywhere on the order
// to what the "retail" price would have been. This webhook makes that saving
// visible by writing explicit "B2B Discount" / "B2B Total Savings" note
// attributes onto the order (visible in the admin's "Additional details"
// panel). It never modifies line items, quantities, or prices.
//
// Incident history (order #1397, 2 Aug 2026): an earlier version of this
// webhook also tried to force a native admin strikethrough by editing the
// order (via orderEditBegin/orderEditSetQuantity/orderEditAddVariant/
// orderEditAddLineItemDiscount). That approach had two serious, separate
// bugs:
//
// 1. Data loss: it removed each discounted line via
//    orderEditSetQuantity(quantity: 0) and tried to re-add the same variant
//    to attach a discount to a "fresh" line. That re-add fails 100% of the
//    time — orderEditAddVariant defaults allowDuplicates to false, and the
//    variant is still "on" the calculated order (at qty 0) from the removal,
//    so Shopify rejects it as a duplicate. The code never checked for that
//    error, so it silently zeroed line after line while every re-add failed,
//    then committed the half-destroyed result unconditionally — permanently
//    deleting 175 line items and every B2B discount note on that order.
//
// 2. Financial bug in the design itself, found while fixing (1): a B2B
//    line's existing price IS ALREADY the discounted amount the customer
//    agreed to pay — that's the whole reason this webhook exists. Applying
//    orderEditAddLineItemDiscount on top of that (whether to the original
//    line, or to a freshly re-added line, which Shopify prices at the same
//    contextual/catalog rate — confirmed via a live, uncommitted test edit)
//    reduces an already-discounted price a second time, undercharging the
//    customer by the discount amount. This was true of the original design
//    too; it just never ran because of bug (1).
//
// Getting a genuine native strikethrough (retail price crossed out, paid
// price shown) without touching the amount charged would require the line's
// base price to be raised to the retail price first and then a matching
// discount applied — order-edit mutations don't offer a supported way to do
// that for an existing catalog variant. Until a safe mechanism is found, this
// webhook only writes informational notes, which fully solves the
// visibility problem (staff can see exact savings in "Additional details")
// with zero risk to line items or pricing.

async function graphqlJson(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  return res.json();
}

function hasErrors(json, dataPath) {
  if (json.errors?.length) return true;
  const userErrors = dataPath.split(".").reduce((acc, key) => acc?.[key], json.data)?.userErrors;
  return Boolean(userErrors?.length);
}

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");

  // ── Standard Webhook Authentication ──────────────────────────────────────
  const { topic, admin, payload, shop } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Unhandled topic", { status: 200 });
  }

  const order = payload; // REST order object
  const lineItems = order.line_items ?? [];
  const orderName = `#${order.order_number}`;

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

    // ── Step 3: Idempotency guard ─────────────────────────────────────────
    // Shopify redelivers ORDERS_CREATE if this handler doesn't respond fast
    // enough. Without this check, a retry would recompute the same notes and
    // overwrite them with a duplicate write — harmless here (this is a full
    // replace of the same content, not additive), but skipping is cheaper
    // and keeps the log signal clean.
    const currentAttrsJson = await graphqlJson(
      admin,
      `query CurrentOrderAttrs($id: ID!) {
        order(id: $id) {
          customAttributes { key }
        }
      }`,
      { id: orderId }
    );
    const alreadyProcessed = currentAttrsJson?.data?.order?.customAttributes?.some(
      (a) => a.key === "B2B Total Savings"
    );

    if (alreadyProcessed) {
      console.log(`[orders/create] ${orderName}: already has B2B discount notes, skipping (likely a webhook retry).`);
      return new Response("OK", { status: 200 });
    }

    // ── Step 4: Write order note attributes (informational only) ───────────
    const totalSaved = totalRetailValue - totalPaidValue;
    const overallPct = totalRetailValue > 0 ? ((totalSaved / totalRetailValue) * 100).toFixed(1) : "0.0";

    discountNotes.unshift({
      name: "B2B Total Savings",
      value: `${fmt(totalSaved)} saved — ${overallPct}% off retail (retail total: ${fmt(totalRetailValue)})`,
    });

    const existingNotes = (order.note_attributes ?? []).filter((n) => !String(n.name).startsWith("B2B "));
    const mergedNotes = [...existingNotes, ...discountNotes];

    const notesJson = await graphqlJson(
      admin,
      `mutation UpdateOrderNotes($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id name }
          userErrors { field message }
        }
      }`,
      {
        input: {
          id: orderId,
          customAttributes: mergedNotes.map((n) => ({
            key: String(n.name),
            value: String(n.value),
          })),
        },
      }
    );

    if (hasErrors(notesJson, "orderUpdate")) {
      console.error(`[orders/create] ${orderName}: failed to write B2B discount notes.`, notesJson.errors ?? notesJson.data?.orderUpdate?.userErrors);
    } else {
      console.log(`[orders/create] ${orderName}: wrote ${discountNotes.length} B2B discount note(s).`);
    }

  } catch (err) {
    // Log but always return 200 — a non-200 causes Shopify to retry 19 times
    console.error(`[orders/create] Unhandled error for order ${order?.id}:`, err);
  }

  // ── Sales rep order notification ─────────────────────────────────────────
  // Independent of the B2B discount-notes logic above: a sales rep should be
  // notified of a customer's order regardless of whether that order happened
  // to carry a catalog discount, so this runs in its own try/catch and never
  // gates on (or is gated by) the block above.
  try {
    const orderId = `gid://shopify/Order/${order.id}`;
    const repInfoJson = await graphqlJson(
      admin,
      `query OrderSalesRepInfo($id: ID!) {
        order(id: $id) {
          customAttributes { key value }
          customer {
            firstName
            lastName
            email
            salesRepCode: metafield(namespace: "custom", key: "sales_reps") { value }
          }
          purchasingEntity {
            ... on PurchasingCompany {
              company { name }
            }
          }
        }
      }`,
      { id: orderId }
    );

    const repInfo = repInfoJson?.data?.order;
    const alreadyNotified = repInfo?.customAttributes?.some((a) => a.key === "Sales Rep Notified");
    const repCode = repInfo?.customer?.salesRepCode?.value?.trim();

    if (!alreadyNotified && repCode) {
      const { default: prisma } = await import("../db.server");
      const rep = await prisma.salesRep.findUnique({
        where: { shop_repCode: { shop, repCode } },
      });

      if (rep && rep.active && rep.email) {
        const { sendSalesRepOrderNotification } = await import("../lib/brevo.server");
        const customer = repInfo.customer;
        const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || customer?.email || "Customer";
        const companyName = repInfo?.purchasingEntity?.company?.name || customerName;

        // Fetch each variant's image and retail price (for the strikethrough
        // savings display, same idea as the B2B discount-notes block above
        // but fetched independently here to keep this block self-contained).
        // Only done once we know a rep will actually be emailed, so a normal
        // order (no rep set up yet) never pays for this extra API call.
        let detailsByVariantId = {};
        if (variantGids.length > 0) {
          const detailsJson = await graphqlJson(
            admin,
            `query LineItemDetails($ids: [ID!]!) {
              nodes(ids: $ids) {
                ... on ProductVariant {
                  id
                  image { url }
                  compareAtPrice
                  standardRetail: metafield(namespace: "custom", key: "standard_retail_price") { value }
                }
              }
            }`,
            { ids: variantGids }
          );
          for (const node of detailsJson?.data?.nodes ?? []) {
            if (node?.id) {
              detailsByVariantId[node.id.split("/").pop()] = {
                imageUrl: node.image?.url ?? null,
                originalPrice: node.standardRetail?.value ?? node.compareAtPrice ?? null,
              };
            }
          }
        }

        await sendSalesRepOrderNotification({
          repEmail: rep.email,
          repName: rep.name,
          orderName,
          customerName,
          companyName,
          lineItems: lineItems.map((li) => {
            const details = detailsByVariantId[String(li.variant_id)] || {};
            const originalPrice = parseFloat(details.originalPrice ?? "0");
            return {
              title: li.title,
              sku: li.sku,
              quantity: li.quantity,
              price: li.price,
              originalPrice: originalPrice > parseFloat(li.price ?? "0") ? originalPrice : null,
              imageUrl: details.imageUrl || null,
            };
          }),
          subtotal: order.subtotal_price ?? order.total_price,
          currency: order.currency,
        });

        await graphqlJson(
          admin,
          `mutation MarkRepNotified($input: OrderInput!) {
            orderUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
          {
            input: {
              id: orderId,
              customAttributes: [
                ...(repInfo.customAttributes ?? []).map((a) => ({ key: a.key, value: a.value })),
                { key: "Sales Rep Notified", value: rep.email },
              ],
            },
          }
        );

        console.log(`[orders/create] ${orderName}: notified sales rep ${rep.email} (code ${repCode}).`);
      } else if (repCode) {
        console.warn(`[orders/create] ${orderName}: customer has sales rep code "${repCode}" but no matching active SalesRep row for shop ${shop}.`);
      }
    }
  } catch (err) {
    console.error(`[orders/create] Sales rep notification failed for order ${order?.id}:`, err);
  }

  return new Response("OK", { status: 200 });
};
