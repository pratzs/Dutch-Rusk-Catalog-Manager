import { useState, useEffect } from 'react';
import {
  reactExtension,
  useCartLineTarget,
  useShop,
  Text,
  InlineStack,
  BlockStack,
} from '@shopify/ui-extensions-react/checkout';

const APP_URL = 'https://dutch-rusk-catalog-manager.onrender.com';

// Module-level cache so we don't re-fetch on every render
const priceCache = {};

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
  const shop = useShop();
  const [fetchedCompareAt, setFetchedCompareAt] = useState(undefined);

  const merchandiseId = line?.merchandise?.id;
  const currentPrice = parseFloat(line?.cost?.amountPerQuantity?.amount ?? '0');
  const currency = line?.cost?.amountPerQuantity?.currencyCode ?? 'NZD';
  const qty = line?.quantity ?? 1;

  // --- Source 1: compareAtAmountPerQuantity (cheapest — no network call) ---
  const compareAtMoney = line?.cost?.compareAtAmountPerQuantity;
  const directCompareAt = compareAtMoney
    ? parseFloat(compareAtMoney.amount)
    : null;

  // --- Source 2: discountAllocations (B2B automatic discount) ---
  const allocations = line?.discountAllocations ?? [];
  const totalDiscount = allocations.reduce(
    (sum, d) => sum + parseFloat(d.discountedAmount?.amount ?? '0'),
    0,
  );

  // --- Source 3: backend API → Admin API compareAtPrice ---
  useEffect(() => {
    // Only fetch if sources 1 & 2 give nothing useful
    if (!merchandiseId || !shop?.myshopifyDomain) return;
    if (directCompareAt !== null && directCompareAt > currentPrice) return;
    if (totalDiscount > 0) return;

    // Check module cache first
    if (priceCache[merchandiseId] !== undefined) {
      setFetchedCompareAt(priceCache[merchandiseId]);
      return;
    }

    const endpoint =
      `${APP_URL}/api/variant-prices` +
      `?variantIds=${encodeURIComponent(merchandiseId)}` +
      `&shop=${encodeURIComponent(shop.myshopifyDomain)}`;

    fetch(endpoint)
      .then((r) => r.json())
      .then(({ prices }) => {
        const v = prices?.[merchandiseId];
        // Use compareAtPrice if set, otherwise fall back to retail price
        const raw = v?.compareAtPrice ?? v?.price ?? null;
        const parsed = raw ? parseFloat(raw) : null;
        const result = parsed && parsed > currentPrice ? parsed : null;
        priceCache[merchandiseId] = result;
        setFetchedCompareAt(result);
      })
      .catch(() => {
        priceCache[merchandiseId] = null;
        setFetchedCompareAt(null);
      });
  }, [merchandiseId, shop?.myshopifyDomain]);

  // --- Resolve the best savings info ---
  let originalPerUnit = null;
  let totalSavings = null;

  if (directCompareAt !== null && directCompareAt > currentPrice) {
    originalPerUnit = directCompareAt;
    totalSavings = (directCompareAt - currentPrice) * qty;
  } else if (totalDiscount > 0) {
    originalPerUnit = currentPrice + totalDiscount / qty;
    totalSavings = totalDiscount;
  } else if (fetchedCompareAt && fetchedCompareAt > currentPrice) {
    originalPerUnit = fetchedCompareAt;
    totalSavings = (fetchedCompareAt - currentPrice) * qty;
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
