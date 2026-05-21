import {
  reactExtension,
  useCartLineTarget,
  useAppMetafields,
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
  const line = useCartLineTarget();
  // Reads the custom.retail_price metafield set on the variant by the sync tool
  const appMetafields = useAppMetafields();

  // For B2B Net 30 orders amountPerQuantity may be 0 (due today = $0).
  // Fall back to totalAmount / quantity which always reflects the real catalog price.
  const rawPerQty = parseFloat(line?.cost?.amountPerQuantity?.amount ?? '0');
  const rawTotal = parseFloat(line?.cost?.totalAmount?.amount ?? '0');
  const qty = line?.quantity ?? 1;
  const currentPrice = rawPerQty > 0 ? rawPerQty : (qty > 0 ? rawTotal / qty : 0);
  const currency = line?.cost?.amountPerQuantity?.currencyCode
    ?? line?.cost?.totalAmount?.currencyCode
    ?? 'NZD';

  // Source 1: metafield retail_price set by the sync
  const retailMeta = appMetafields?.find(
    (m) => m.metafield?.namespace === 'custom' && m.metafield?.key === 'retail_price'
  );
  const metafieldPrice = retailMeta ? parseFloat(retailMeta.metafield.value) : null;

  // Source 2: compareAtAmountPerQuantity (native Shopify, works if compare_at > price)
  const compareAtMoney = line?.cost?.compareAtAmountPerQuantity;
  const directCompareAt = compareAtMoney ? parseFloat(compareAtMoney.amount) : null;

  // Source 3: discountAllocations (automatic discount / B2B discount codes)
  const allocations = line?.discountAllocations ?? [];
  const totalDiscount = allocations.reduce(
    (sum, d) => sum + parseFloat(d.discountedAmount?.amount ?? '0'), 0,
  );

  // Pick best source — metafield takes priority for B2B catalog pricing
  let originalPerUnit = null;
  let totalSavings = null;

  if (metafieldPrice && metafieldPrice > currentPrice) {
    originalPerUnit = metafieldPrice;
    totalSavings = (metafieldPrice - currentPrice) * qty;
  } else if (directCompareAt !== null && directCompareAt > currentPrice) {
    originalPerUnit = directCompareAt;
    totalSavings = (directCompareAt - currentPrice) * qty;
  } else if (totalDiscount > 0) {
    originalPerUnit = currentPrice + totalDiscount / qty;
    totalSavings = totalDiscount;
  }

  if (!originalPerUnit || !totalSavings) return null;

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
