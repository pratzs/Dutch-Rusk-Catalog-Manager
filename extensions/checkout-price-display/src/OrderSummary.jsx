import {
  reactExtension,
  useCartLines,
  useAppMetafields,
  Text,
  InlineStack,
  BlockStack,
  Divider,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension(
  'purchase.checkout.reductions.render-after',
  () => <TotalSavings />,
);

function formatMoney(amount, currencyCode) {
  return new Intl.NumberFormat('en-NZ', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
  }).format(amount);
}

function TotalSavings() {
  const lines = useCartLines();
  // Returns all metafield entries for all lines' merchandise
  const appMetafields = useAppMetafields();

  let totalSavings = 0;
  let currency = 'NZD';

  for (const line of lines ?? []) {
    if (!line?.cost) continue;
    const rawPerQty = parseFloat(line.cost.amountPerQuantity?.amount ?? '0');
    const rawTotal = parseFloat(line.cost.totalAmount?.amount ?? '0');
    const qty = line.quantity ?? 1;
    // Net 30 orders may return amountPerQuantity=0; use totalAmount/qty instead
    const current = rawPerQty > 0 ? rawPerQty : (qty > 0 ? rawTotal / qty : 0);
    currency = line.cost.amountPerQuantity?.currencyCode ?? line.cost.totalAmount?.currencyCode ?? 'NZD';
    const variantId = line.merchandise?.id;

    // Source 1: metafield retail_price for this variant
    const retailMeta = appMetafields?.find(
      (m) =>
        m.target?.id === variantId &&
        m.metafield?.namespace === 'custom' &&
        m.metafield?.key === 'retail_price'
    );
    const metafieldPrice = retailMeta ? parseFloat(retailMeta.metafield.value) : null;

    // Source 2: compareAtAmountPerQuantity
    const compareAtMoney = line.cost.compareAtAmountPerQuantity;
    const compareAt = compareAtMoney ? parseFloat(compareAtMoney.amount) : null;

    // Source 3: discountAllocations
    const allocations = line.discountAllocations ?? [];
    const discount = allocations.reduce(
      (sum, d) => sum + parseFloat(d.discountedAmount?.amount ?? '0'), 0,
    );

    if (metafieldPrice && metafieldPrice > current) {
      totalSavings += (metafieldPrice - current) * qty;
    } else if (compareAt && compareAt > current) {
      totalSavings += (compareAt - current) * qty;
    } else if (discount > 0) {
      totalSavings += discount;
    }
  }

  if (totalSavings <= 0) return null;

  return (
    <BlockStack spacing="tight">
      <Divider />
      <InlineStack blockAlignment="center" spacing="base">
        <Text size="small" emphasis="bold">Total savings</Text>
        <Text size="small" appearance="success" emphasis="bold">
          -{formatMoney(totalSavings, currency)}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
