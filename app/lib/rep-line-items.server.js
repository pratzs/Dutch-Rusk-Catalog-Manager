/**
 * Turn the REST order webhook's line items into the rows the sales rep email
 * shows: the price the buyer actually paid, and the retail price to strike
 * through when it is higher.
 *
 * li.price is the line BEFORE discounts. On this shop the cart transform
 * raises B2B lines to retail and the wholesale discount pulls them back, so
 * li.price is retail and the paid price only exists once the discount
 * allocations come off. Using li.price as "the price" is what put retail in
 * the email with no strikethrough (seen on the #2118 test, 25 Sept).
 *
 * @param {any[]} lineItems REST order line_items
 * @param {Record<string, { imageUrl?: string|null, originalPrice?: string|null }>} detailsByVariantId
 */
export function repEmailLineItems(lineItems, detailsByVariantId = {}) {
  return (lineItems ?? []).map((li) => {
    const details = detailsByVariantId[String(li.variant_id)] || {};
    const qty = parseInt(li.quantity ?? 1, 10);
    const listed = parseFloat(li.price ?? "0");
    const allocated = (li.discount_allocations ?? []).reduce((sum, d) => sum + parseFloat(d.amount ?? "0"), 0);
    const paid = listed - (qty > 0 ? allocated / qty : 0);
    const was = Math.max(listed, parseFloat(details.originalPrice ?? "0") || 0);
    return {
      title: li.title,
      sku: li.sku,
      quantity: li.quantity,
      price: paid.toFixed(2),
      originalPrice: was - paid > 0.005 ? was : null,
      imageUrl: details.imageUrl || null,
    };
  });
}
