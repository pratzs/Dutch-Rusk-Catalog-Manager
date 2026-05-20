import {
  reactExtension,
  useCartLines,
  Text,
  InlineStack,
  BlockStack,
  Divider,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension(
  'purchase.checkout.order-summary-line-items.render-after',
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
    const compareAtMoney = line.cost.compareAtAmountPerQuantity;
    if (!compareAtMoney) continue;

    const compareAt = parseFloat(compareAtMoney.amount);
    const current = parseFloat(line.cost.amountPerQuantity.amount);
    currency = line.cost.amountPerQuantity.currencyCode;

    if (compareAt > current) {
      totalSavings += (compareAt - current) * line.quantity;
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
