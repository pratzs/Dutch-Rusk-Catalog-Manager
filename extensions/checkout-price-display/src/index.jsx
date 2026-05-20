import {
  reactExtension,
  useCartLineTarget,
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

function getSavings(line) {
  if (!line?.cost) return null;

  const current = parseFloat(line.cost.amountPerQuantity.amount);
  const currency = line.cost.amountPerQuantity.currencyCode;
  const qty = line.quantity ?? 1;

  // Source 1: compareAtAmountPerQuantity
  // Populated when the variant has a compare_at_price set in Shopify admin
  const compareAtMoney = line.cost.compareAtAmountPerQuantity;
  if (compareAtMoney) {
    const compareAt = parseFloat(compareAtMoney.amount);
    if (compareAt > current) {
      return {
        originalPerUnit: compareAt,
        totalSavings: (compareAt - current) * qty,
        currency,
      };
    }
  }

  // Source 2: discountAllocations
  // Populated when B2B catalog pricing is applied as an automatic discount
  const allocations = line.discountAllocations ?? [];
  if (allocations.length > 0) {
    const totalDiscount = allocations.reduce((sum, d) => {
      return sum + parseFloat(d.discountedAmount.amount);
    }, 0);
    if (totalDiscount > 0) {
      const originalPerUnit = current + totalDiscount / qty;
      return {
        originalPerUnit,
        totalSavings: totalDiscount,
        currency,
      };
    }
  }

  return null;
}

function CartLineSavings() {
  const line = useCartLineTarget();
  const savings = getSavings(line);
  if (!savings) return null;

  const { originalPerUnit, totalSavings, currency } = savings;

  return (
    <BlockStack spacing="extraTight">
      <InlineStack spacing="tight" blockAlignment="center">
        <Text appearance="subdued" size="small" textDecoration="line-through">
          {formatMoney(originalPerUnit, currency)} each
        </Text>
        <Text appearance="success" size="small">
          Save {formatMoney(totalSavings, currency)}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
