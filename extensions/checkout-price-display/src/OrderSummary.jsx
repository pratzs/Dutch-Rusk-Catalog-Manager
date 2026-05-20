import {
  reactExtension,
  useCartLines,
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

  let totalSavings = 0;
  let currency = 'NZD';

  for (const line of lines) {
    if (!line?.cost) continue;

    const current = parseFloat(line.cost.amountPerQuantity.amount);
    currency = line.cost.amountPerQuantity.currencyCode;
    const qty = line.quantity ?? 1;

    // Source 1: compareAtAmountPerQuantity
    const compareAtMoney = line.cost.compareAtAmountPerQuantity;
    if (compareAtMoney) {
      const compareAt = parseFloat(compareAtMoney.amount);
      if (compareAt > current) {
        totalSavings += (compareAt - current) * qty;
        continue;
      }
    }

    // Source 2: discountAllocations (B2B catalog discounts)
    const allocations = line.discountAllocations ?? [];
    if (allocations.length > 0) {
      totalSavings += allocations.reduce((sum, d) => {
        return sum + parseFloat(d.discountedAmount.amount);
      }, 0);
    }
  }

  if (totalSavings <= 0) return null;

  return (
    <BlockStack spacing="tight">
      <Divider />
      <InlineStack blockAlignment="center" spacing="base">
        <Text size="small" emphasis="bold">
          Total savings
        </Text>
        <Text size="small" appearance="success" emphasis="bold">
          -{formatMoney(totalSavings, currency)}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
