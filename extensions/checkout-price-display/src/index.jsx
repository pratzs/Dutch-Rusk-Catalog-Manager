import {
  reactExtension,
  useCartLine,
  Text,
  InlineStack,
  BlockStack,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension(
  'purchase.checkout.cart-line-item.render-after',
  () => <CartLineSavings />,
);

function formatMoney(amount, currencyCode) {
  return new Intl.NumberFormat('en-NZ', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
  }).format(amount);
}

function CartLineSavings() {
  const { cost, quantity } = useCartLine();

  const compareAtMoney = cost.compareAtAmountPerQuantity;
  if (!compareAtMoney) return null;

  const compareAt = parseFloat(compareAtMoney.amount);
  const current = parseFloat(cost.amountPerQuantity.amount);
  const currency = cost.amountPerQuantity.currencyCode;

  if (compareAt <= current) return null;

  const savingsPerUnit = compareAt - current;
  const totalSavings = savingsPerUnit * quantity;

  return (
    <BlockStack spacing="extraTight">
      <InlineStack spacing="tight" blockAlignment="center">
        <Text appearance="subdued" size="small" textDecoration="line-through">
          {formatMoney(compareAt, currency)}
        </Text>
        <Text appearance="success" size="small">
          Save {formatMoney(totalSavings, currency)}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
