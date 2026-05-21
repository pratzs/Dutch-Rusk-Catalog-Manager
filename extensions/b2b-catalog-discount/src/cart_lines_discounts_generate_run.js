// B2B Catalog Discount — Shopify Function
//
// Applies the correct per-line discount for B2B catalog customers so that
// every order line item has a real discount_allocation. This makes the
// Shopify Admin order page show the traditional "Catalog name discount"
// strikethrough, and gives ERPs (Ostendo, Odoo) proper discount records.
//
// Logic per cart line:
//   1. Is the buyer a B2B company? If not → no discount.
//   2. Read company metafields: priceListId + discountPct (blanket %).
//   3. Read variant metafield: catalog_fixed_prices JSON.
//   4. If this priceListId has a fixed price for this variant → use it.
//      Else → apply the blanket discountPct to the line's base price.
//   5. discount_amount = base_price − catalog_price (per unit).
//   6. Apply as a fixedAmount per-item discount labelled "Catalog name discount".
//
// Prerequisites (set up by api.catalog-price-sync):
//   • company metafield custom.catalog_pricelist_id = Shopify PriceList GID
//   • company metafield custom.catalog_discount_pct  = blanket % string e.g. "20"
//   • variant metafield custom.catalog_fixed_prices  = JSON {"priceListGid": "25.04", ...}
//
// IMPORTANT: Remove the blanket % discount from your B2B catalog price lists
// in Shopify Admin (set to 0% or remove the adjustment) before enabling this
// function as an Automatic Discount — otherwise customers will be double-discounted.
// Fixed-price overrides should also be removed from the catalog once the
// sync has populated the variant metafields.

const DISCOUNT_LABEL = "Catalog name discount";
const MIN_DISCOUNT = 0.001; // ignore rounding dust

/**
 * @param {import("../generated/api").CartInput} input
 * @returns {import("../generated/api").CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const noDiscount = { operations: [] };

  // Only apply to B2B purchasing company checkouts
  const company = input?.cart?.buyerIdentity?.purchasingCompany?.company;
  if (!company) return noDiscount;

  const priceListId = company.priceListId?.value;
  if (!priceListId) return noDiscount;

  const discountPct = parseFloat(company.discountPct?.value ?? "0");
  if (isNaN(discountPct) || discountPct < 0) return noDiscount;

  const candidates = [];

  for (const line of input.cart.lines ?? []) {
    const variant = line.merchandise;
    if (variant?.__typename !== "ProductVariant") continue;

    // Base price = what the customer sees before our function applies anything.
    // After you remove catalog pricing, this equals the retail price.
    const basePrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    if (!basePrice || basePrice <= 0) continue;

    // ── Determine catalog price for this variant ──────────────────────────
    let catalogPrice = null;

    // Check for a fixed-price override in this price list
    const fixedPricesRaw = variant.catalogFixedPrices?.value;
    if (fixedPricesRaw) {
      try {
        const fixedPrices = JSON.parse(fixedPricesRaw);
        const override = fixedPrices[priceListId];
        if (override !== undefined && override !== null) {
          catalogPrice = parseFloat(override);
        }
      } catch {
        // malformed JSON — fall through to blanket %
      }
    }

    // No fixed override → apply blanket percentage
    if (catalogPrice === null) {
      if (discountPct <= 0) continue; // no discount for this company
      catalogPrice = basePrice * (1 - discountPct / 100);
    }

    if (isNaN(catalogPrice) || catalogPrice >= basePrice) continue;

    const discountAmount = basePrice - catalogPrice;
    if (discountAmount < MIN_DISCOUNT) continue;

    candidates.push({
      message: DISCOUNT_LABEL,
      targets: [
        {
          cartLine: {
            id: line.id,
            quantity: line.quantity,
          },
        },
      ],
      value: {
        fixedAmount: {
          // Per-unit discount so the allocation scales correctly with quantity
          amount: discountAmount.toFixed(2),
          appliesToEachItem: true,
        },
      },
    });
  }

  if (!candidates.length) return noDiscount;

  return {
    operations: [
      {
        productDiscountsAdd: {
          // ALL = every candidate applies (each targets a different line)
          candidates,
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
