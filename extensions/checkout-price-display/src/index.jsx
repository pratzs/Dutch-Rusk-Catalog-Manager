import {
  reactExtension,
  useCartLineTarget,
  useCartLines,
  Text,
  InlineStack,
  BlockStack,
  Divider,
} from '@shopify/ui-extensions-react/checkout';

// Per-line savings: renders after each cart line item
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
  const line = useCartLineTarget();

  const compareAtMoney = line?.cost?.compareAtAmountPerQuantity;
  if (!compareAtMoney) return null;

  const compareAt = parseFloat(compareAtMoney.amount);
  const current = parseFloat(line.cost.amountPerQuantity.amount);
  const currency = line.cost.amountPerQuantity.currencyCode;

  if (compareAt <= current) return null;

  const savingsTotal = (compareAt - current) * line.quantity;

  return (
    <BlockStack spacing="extraTight">
      <InlineStack spacing="tight" blockAlignment="center">
        <Text appearance="subdued" size="small" textDecoration="line-through">
          {formatMoney(compareAt, currency)} each
        </Text>
        <Text appearance="success" size="small">
          Save {formatMoney(savingsTotal, currency)}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
