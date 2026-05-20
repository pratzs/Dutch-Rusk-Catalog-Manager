import { useState, useEffect } from 'react';
import {
  reactExtension,
  useCartLines,
  useShop,
  Text,
  InlineStack,
  BlockStack,
  Divider,
} from '@shopify/ui-extensions-react/checkout';

const APP_URL = 'https://dutch-rusk-catalog-manager.onrender.com';
const priceCache = {};

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
  const shop = useShop();
  const [fetchedPrices, setFetchedPrices] = useState({});

  const shopDomain = shop?.myshopifyDomain;

  useEffect(() => {
    if (!shopDomain || !lines?.length) return;

    // Collect variant IDs that need a backend lookup
    const needsFetch = lines
      .filter((line) => {
        const compareAt = line?.cost?.compareAtAmountPerQuantity;
        const current = parseFloat(line?.cost?.amountPerQuantity?.amount ?? '0');
        const allocations = line?.discountAllocations ?? [];
        const hasDiscount = allocations.reduce(
          (sum, d) => sum + parseFloat(d.discountedAmount?.amount ?? '0'), 0,
        ) > 0;
        const hasCompareAt = compareAt && parseFloat(compareAt.amount) > current;
        return !hasCompareAt && !hasDiscount;
      })
      .map((line) => line.merchandise?.id)
      .filter((id) => id && priceCache[id] === undefined);

    if (!needsFetch.length) return;

    const endpoint =
      `${APP_URL}/api/variant-prices` +
      `?variantIds=${needsFetch.map(encodeURIComponent).join(',')}` +
      `&shop=${encodeURIComponent(shopDomain)}`;

    fetch(endpoint)
      .then((r) => r.json())
      .then(({ prices }) => {
        const updates = {};
        for (const id of needsFetch) {
          const v = prices?.[id];
          const raw = v?.compareAtPrice ?? v?.price ?? null;
          priceCache[id] = raw ? parseFloat(raw) : null;
          updates[id] = priceCache[id];
        }
        setFetchedPrices((prev) => ({ ...prev, ...updates }));
      })
      .catch(() => {
        for (const id of needsFetch) priceCache[id] = null;
      });
  }, [shopDomain, lines?.length]);

  let totalSavings = 0;
  let currency = 'NZD';

  for (const line of lines ?? []) {
    if (!line?.cost) continue;
    const current = parseFloat(line.cost.amountPerQuantity.amount);
    currency = line.cost.amountPerQuantity.currencyCode;
    const qty = line.quantity ?? 1;
    const id = line.merchandise?.id;

    const compareAtMoney = line.cost.compareAtAmountPerQuantity;
    if (compareAtMoney) {
      const compareAt = parseFloat(compareAtMoney.amount);
      if (compareAt > current) { totalSavings += (compareAt - current) * qty; continue; }
    }

    const allocations = line.discountAllocations ?? [];
    const discount = allocations.reduce(
      (sum, d) => sum + parseFloat(d.discountedAmount?.amount ?? '0'), 0,
    );
    if (discount > 0) { totalSavings += discount; continue; }

    const fetched = fetchedPrices[id] ?? priceCache[id];
    if (fetched && fetched > current) {
      totalSavings += (fetched - current) * qty;
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
