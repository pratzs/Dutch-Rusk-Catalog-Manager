// app/routes/webhooks.orders.create.jsx
//
// Fires on every new order. For B2B catalog orders where the customer pays a
// discounted catalog price, Shopify records NO discount_allocations — the lower
// price is simply baked in silently. This webhook enriches the order with
// explicit discount note_attributes and forces a native admin strikethrough by
// applying a manual line-item discount directly to each discounted line, via
// the Admin API's order-edit ("calculated order") flow.
//
// SAFETY: nothing is written to the real order until orderEditCommit is
// called, so as long as we abort BEFORE committing on any error, the real
// order is never touched. That guarantee is the whole point of the
// error-checking below — do not remove it.
//
// Incident history (order #1397, 2 Aug 2026): the original implementation
// removed each discounted line via orderEditSetQuantity(quantity: 0) and
// tried to re-add the same variant via orderEditAddVariant to attach the
// discount to a "fresh" line. That add call fails 100% of the time —
// orderEditAddVariant defaults allowDuplicates to false, and the variant is
// still "on" the calculated order (at qty 0) from the removal, so Shopify
// rejects it as a duplicate. The old code never checked for that error, so it
// silently zeroed line after line while every re-add failed, then committed
// the half-destroyed result unconditionally — permanently deleting 175 line
// items and every B2B discount note on that order. A second latent bug
// compounded it: the property-setting step called `orderEditUpdateLineItem`,
// a mutation that doesn't exist in the Admin API schema, so it always
// errored too (harmlessly, since it's after the destructive part).
//
// Fix: orderEditAddLineItemDiscount can be applied directly to the ORIGINAL
// calculated line item (no removal/re-add needed at all), which is both
// simpler and eliminates the destructive step entirely.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls admin.graphql and retries on Shopify's THROTTLED error with backoff.
// Returns { data, errors } — callers must still check field-level userErrors.
async function graphqlWithRetry(admin, query, variables, { retries = 3, label } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await admin.graphql(query, { variables });
    const json = await res.json();
    const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");

    if (!throttled) return json;

    if (attempt < retries) {
      const waitMs = 1000 * 2 ** attempt;
      console.warn(`[orders/create] ${label ?? "GraphQL call"} throttled, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(waitMs);
    } else {
      console.error(`[orders/create] ${label ?? "GraphQL call"} still throttled after ${retries} retries`);
      return json;
    }
  }
}

// True if the response has top-level GraphQL errors or field-level userErrors.
function hasErrors(json, dataPath) {
  if (json.errors?.length) return true;
  const userErrors = dataPath.split(".").reduce((acc, key) => acc?.[key], json.data)?.userErrors;
  return Boolean(userErrors?.length);
}

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");

  // ── Standard Webhook Authentication ──────────────────────────────────────
  const { topic, admin, payload } = await authenticate.webhook(request);

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
    // enough (large orders can be slow). Without this check, a retry would
    // recompute the same discounts and stack a second discount on top of
    // lines already committed by the first delivery. note_attributes on the
    // webhook payload is a creation-time snapshot (always empty), so we need
    // a live read of the order's current state to detect a prior run.
    const currentAttrsRes = await admin.graphql(
      `query CurrentOrderAttrs($id: ID!) {
        order(id: $id) {
          customAttributes { key }
        }
      }`,
      { variables: { id: orderId } }
    );
    const currentAttrsJson = await currentAttrsRes.json();
    const alreadyProcessed = currentAttrsJson?.data?.order?.customAttributes?.some(
      (a) => a.key === "B2B Total Savings"
    );

    if (alreadyProcessed) {
      console.log(`[orders/create] ${orderName}: already has B2B discount notes, skipping (likely a webhook retry).`);
      return new Response("OK", { status: 200 });
    }

    // ── Step 4: Trigger explicit orderEdit mutation flow ────────────────────
    // Nothing below writes to the REAL order until orderEditCommit succeeds.
    // If anything goes wrong before that point, we bail out without
    // committing — the calculated order (a draft) is simply discarded and
    // the live order is left completely untouched.
    const editBeginJson = await graphqlWithRetry(
      admin,
      `mutation BeginOrderEdit($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 250) {
              nodes {
                id
                variant { id }
              }
              pageInfo { hasNextPage }
            }
          }
          userErrors { field message }
        }
      }`,
      { id: orderId },
      { label: `orderEditBegin ${orderName}` }
    );

    const editId = editBeginJson?.data?.orderEditBegin?.calculatedOrder?.id;
    const calcLines = editBeginJson?.data?.orderEditBegin?.calculatedOrder?.lineItems?.nodes ?? [];
    const hasMoreLines = editBeginJson?.data?.orderEditBegin?.calculatedOrder?.lineItems?.pageInfo?.hasNextPage;

    if (hasErrors(editBeginJson, "orderEditBegin") || !editId) {
      console.error(`[orders/create] ${orderName}: orderEditBegin failed, skipping discount swap.`, editBeginJson?.errors ?? editBeginJson?.data?.orderEditBegin?.userErrors);
      return new Response("OK", { status: 200 });
    }

    if (hasMoreLines) {
      console.warn(`[orders/create] ${orderName}: order has more than 250 line items — some may not get the strikethrough treatment.`);
    }

    let editFailed = false;

    for (const li of lineItems) {
      if (editFailed) break;
      if (!li.variant_id) continue;

      const vGid = `gid://shopify/ProductVariant/${li.variant_id}`;
      const calcLi = calcLines.find((cl) => cl.variant?.id === vGid);
      const variant = variantMap[String(li.variant_id)];

      if (!calcLi || !variant) continue;

      const retailPrice = parseFloat(variant.standardRetail?.value ?? variant.compareAtPrice ?? variant.price ?? "0");
      const paidPrice = parseFloat(li.price ?? "0");

      if (retailPrice <= paidPrice) continue;

      console.log(`[orders/create] ${orderName}: Applying discount directly to line ${li.id} (no removal — line stays intact)...`);

      // Apply the catalog discount markdown straight onto the EXISTING
      // calculated line item. No removal, no re-add — the line item is never
      // at risk of being lost, regardless of how this call resolves.
      const amount = (retailPrice - paidPrice).toFixed(2);
      const discountJson = await graphqlWithRetry(
        admin,
        `mutation AddDiscountToLine($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
          orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
            userErrors { field message }
          }
        }`,
        {
          id: editId,
          lineItemId: calcLi.id,
          discount: {
            fixedValue: { amount: String(amount), currencyCode: "NZD" },
            description: `Wholesale Catalog Discount (retail ${fmt(retailPrice)}/ea)`,
          },
        },
        { label: `orderEditAddLineItemDiscount ${orderName}/${li.id}` }
      );

      if (hasErrors(discountJson, "orderEditAddLineItemDiscount")) {
        console.error(`[orders/create] ${orderName}: failed to apply discount to line ${li.id}, aborting edit without committing.`, discountJson.errors ?? discountJson.data?.orderEditAddLineItemDiscount?.userErrors);
        editFailed = true;
        break;
      }
    }

    if (editFailed) {
      // Do NOT commit. The calculated order is a draft only — leaving it
      // uncommitted means the real order retains every original line item
      // and price exactly as placed. Discount notes below are skipped too,
      // since they'd otherwise describe discounts that never actually applied.
      console.error(`[orders/create] ${orderName}: discount application aborted, real order left untouched. Needs manual reprocessing.`);
      return new Response("OK", { status: 200 });
    }

    // Commit the edit — only reached if every discount above applied cleanly.
    const commitJson = await graphqlWithRetry(
      admin,
      `mutation CommitOrderEdit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Wholesale Catalog Discount") {
          userErrors { field message }
        }
      }`,
      { id: editId },
      { label: `orderEditCommit ${orderName}` }
    );

    if (hasErrors(commitJson, "orderEditCommit")) {
      console.error(`[orders/create] ${orderName}: orderEditCommit reported errors — order state should be verified manually.`, commitJson.errors ?? commitJson.data?.orderEditCommit?.userErrors);
      return new Response("OK", { status: 200 });
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

    const notesJson = await graphqlWithRetry(
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
      },
      { label: `orderUpdate ${orderName}` }
    );

    if (hasErrors(notesJson, "orderUpdate")) {
      console.error(`[orders/create] ${orderName}: failed to write B2B discount notes.`, notesJson.errors ?? notesJson.data?.orderUpdate?.userErrors);
    } else {
      console.log(`[orders/create] ${orderName}: applied discounts for native strikethrough and wrote ${discountNotes.length} note(s).`);
    }

  } catch (err) {
    // Log but always return 200 — a non-200 causes Shopify to retry 19 times
    console.error(`[orders/create] Unhandled error for order ${order?.id}:`, err);
  }

  return new Response("OK", { status: 200 });
};
