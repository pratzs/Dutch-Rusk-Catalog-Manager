// B2B catalog pricing + BOGO, on Shopify's CURRENT Discounts API
// (cart.lines.discounts.generate.run).
//
// This is a faithful port of b2b-custom-prices, which runs on the deprecated
// purchase.product-discount.run API. The logic is identical; only the API and
// the output shape differ. tests/parity.test.js runs both over the same carts
// and asserts the resulting per-unit prices match, so the two cannot drift
// while both exist.
//
// WHY THE PORT: the pair of Functions that produce the visible saving
// (b2b-price-transformer raises each line to retail, this one brings it back to
// the catalog price) share an 11M instruction budget, and the old API is
// roughly twice as expensive. That capped carts at ~45 lines, above which the
// transform stood down and orders arrived with no struck-through price and no
// "B2B Wholesale Price" rows -- #1904 (65 lines), #1909, #1913 and #1914 all
// landed that way, and real carts reach 65 lines. Measured on the real runner
// with real live price maps:
//
//     cart lines      old API        this API
//        45           10.04M          7.93M
//        65           over            5.64M
//        80           over            6.79M
//        100          over            8.63M
//        130          over           10.86M
//
// (The 45-line figures use a worst-case map of 12 keys; the rest use real live
// maps, which average 2.04 keys.) That headroom is what lets the transform's
// line guard rise from 45 to ~100 and covers every order this business takes.

const MIN_DISCOUNT = 0.001; // ignore rounding dust

/**
 * @param {import("../generated/api").CartInput} input
 * @returns {import("../generated/api").CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const noDiscount = { operations: [] };

  const company = input?.cart?.buyerIdentity?.purchasingCompany?.company;
  const priceListId = company?.priceListId?.value;
  const discountPct = parseFloat(company?.discountPct?.value ?? "0");

  // ── Do any deals even reach this buyer? ───────────────────────────────────
  // Parsed once, before touching the cart. All five deals are currently scoped
  // to General Catalog, so for every other catalog this comes back empty and
  // the cheap single pass below is used instead of the full deal machinery.
  // Of the orders that actually lost their strikethrough, #1913 and #1914
  // (Night n Day) take this fast path outright. #1904 is on General Catalog and
  // does carry deal products, so it takes the path below -- which is why that
  // path only builds state for the lines a deal actually names.
  //
  // (#1909 was a different fault entirely: Zone Bowling Henderson sits on two
  // catalogs, 35 of its 39 lines were priced from the TEEG list, and the
  // company metafield named only its own list, so no catalog price was found
  // and the transform stood down. Nothing to do with cart size.)
  let applicableBundles = null;
  const bogoRaw = input?.discount?.bogoBundles?.value;
  if (bogoRaw) {
    let bundles;
    try {
      bundles = JSON.parse(bogoRaw);
    } catch {
      bundles = [];
    }
    if (Array.isArray(bundles)) {
      for (const bundle of bundles) {
        const catalogIds = Array.isArray(bundle?.catalogIds) ? bundle.catalogIds : [];
        // Unscoped deals apply to everyone; scoped ones only to their catalogs.
        if (catalogIds.length > 0 && !catalogIds.includes(priceListId)) continue;
        if (!applicableBundles) applicableBundles = [];
        applicableBundles.push(bundle);
      }
    }
  }

  // Which variants any applicable deal actually names. On a General Catalog
  // cart most lines are not in a deal at all -- #1904 is 65 lines with 8 -- and
  // only these need the per-line state and second pass the deal maths wants.
  // Everything else is priced and emitted in the same single pass the fast path
  // uses, which is what keeps a cart with deals in it as cheap as one without.
  let dealVariantIds = null;
  if (applicableBundles) {
    dealVariantIds = new Set();
    for (const bundle of applicableBundles) {
      const ids = Array.isArray(bundle?.variantIds) ? bundle.variantIds : [];
      for (const id of ids) dealVariantIds.add(id);
    }
  }

  // ── Fast path: no deal can apply, so price each line and emit in one pass ──
  if (!applicableBundles) {
    const fast = [];
    for (const line of input.cart.lines ?? []) {
      const variant = line.merchandise;
      if (variant?.__typename !== "ProductVariant") continue;

      const retailPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
      if (!priceListId || !(retailPrice > 0)) continue;

      let catalog = null;
      const raw = variant.catalogFixedPrices?.value;
      if (raw) {
        try {
          const m = JSON.parse(raw);
          const p = m[priceListId];
          if (p !== undefined && p !== null) catalog = parseFloat(p);
        } catch (e) {
          // malformed JSON — fall through to the blanket percentage
        }
      }
      if (catalog === null && discountPct > 0) {
        const sr = parseFloat(variant.standardRetailPrice?.value ?? "0");
        if (sr > 0) catalog = sr * (1 - discountPct / 100);
      }
      if (catalog === null || !(catalog < retailPrice - MIN_DISCOUNT)) continue;

      fast.push({
        targets: [{ cartLine: { id: line.id, quantity: line.quantity } }],
        value: { fixedAmount: { amount: (retailPrice - catalog).toFixed(2), appliesToEachItem: true } },
        message: "B2B Wholesale Price",
      });
    }
    if (!fast.length) return noDiscount;
    return { operations: [{ productDiscountsAdd: { candidates: fast, selectionStrategy: "ALL" } }] };
  }

  // Deal-eligible lines only. Plain lines go straight into `candidates`.
  const lines = [];
  const candidates = [];

  for (const line of input.cart.lines ?? []) {
    const variant = line.merchandise;
    if (variant?.__typename !== "ProductVariant") continue;

    // Retail once the transform has raised this line; the catalog price if it
    // stood down.
    const retailPrice = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    let wholesalePrice = retailPrice;

    // Kept in scope so the BOGO block can tell whether the transform ran.
    let catalogPriceForLine = null;

    if (priceListId) {
      const standardRetail = parseFloat(variant.standardRetailPrice?.value ?? "0");
      let targetWholesalePrice = null;

      // ── PRIMARY: the catalog price synced from the Shopify price lists ────
      const fixedPricesRaw = variant.catalogFixedPrices?.value;
      if (fixedPricesRaw) {
        try {
          const fixedPricesMap = JSON.parse(fixedPricesRaw);
          const fixedPrice = fixedPricesMap[priceListId];
          if (fixedPrice !== undefined && fixedPrice !== null) {
            targetWholesalePrice = parseFloat(fixedPrice);
          }
        } catch (e) {
          // malformed JSON — fall through to the blanket percentage
        }
      }

      // ── SECONDARY: the company's blanket percentage, if the map has no
      // entry yet. Every company is currently at 0, so this is dormant.
      if (targetWholesalePrice === null && discountPct > 0 && standardRetail > 0) {
        targetWholesalePrice = standardRetail * (1 - discountPct / 100);
      }

      catalogPriceForLine = targetWholesalePrice;

      if (targetWholesalePrice !== null && retailPrice > targetWholesalePrice + 0.01) {
        wholesalePrice = targetWholesalePrice;
      }
    }

    // Did the transform actually raise this line? Every deal calculation below
    // is a percentage OFF the price in hand, so on a cart where the transform
    // stood down a deal would discount the catalog price a second time and give
    // a free unit on top. If the line still sits at its catalog price, it was
    // not raised. With no catalog price known the transform would not have
    // raised it either and the price in hand is the plain one, so a deal off it
    // is legitimate — hence the default of true.
    // A line no deal names can never gain a free unit or a deal price, so its
    // final row is already known: emit it here and skip the per-line object and
    // the second pass entirely. Deliberately uses the same thresholds as the
    // tier loop below so the output is identical to building the object.
    if (!dealVariantIds.has(variant.id)) {
      if (wholesalePrice < retailPrice - MIN_DISCOUNT) {
        candidates.push({
          targets: [{ cartLine: { id: line.id, quantity: line.quantity } }],
          value: { fixedAmount: { amount: (retailPrice - wholesalePrice).toFixed(2), appliesToEachItem: true } },
          message: "B2B Wholesale Price",
        });
      }
      continue;
    }

    const transformRaised =
      catalogPriceForLine === null ? true : retailPrice > catalogPriceForLine + 0.011;

    lines.push({
      id: line.id,
      quantity: line.quantity,
      variantId: variant.id,
      retailPrice,
      wholesalePrice,
      freeQty: 0,
      dealPaidQty: 0,
      dealPaidPrice: null,
      transformRaised,
    });
  }

  // ── BOGO Bundles ──────────────────────────────────────────────────────────
  // Config is JSON on this discount's own metafield, edited via the app's BOGO
  // Bundles page. All five deals are currently scoped to General Catalog, so
  // for every other catalog each bundle exits at the catalogIds check.
  {
    {
      for (const bundle of applicableBundles) {
        const buyQty = Number(bundle?.buyQty);
        const getQty = Number(bundle?.getQty);
        const variantIds = Array.isArray(bundle?.variantIds) ? bundle.variantIds : [];
        if (!buyQty || buyQty <= 0 || !getQty || getQty <= 0 || variantIds.length === 0) continue;

        // Catalog scoping was already resolved when applicableBundles was built.

        const variantIdSet = new Set(variantIds);
        // Only lines the transform raised — see transformRaised above.
        const matchingLines = lines.filter((l) => variantIdSet.has(l.variantId) && l.transformRaised);
        if (matchingLines.length === 0) continue;

        // "Buy N Get M Free" needs N paid + M free per group, not N total.
        // Below that the deal is inactive and catalog pricing stands untouched.
        const totalQty = matchingLines.reduce((sum, l) => sum + l.quantity, 0);
        const groupSize = buyQty + getQty;
        const groups = Math.floor(totalQty / groupSize);
        if (groups <= 0) continue;

        // Optional per-deal override %, only once the deal is actually active.
        // It may only ever LOWER a price: if the customer's own catalog rate is
        // already deeper, they keep it, because a promotion must never leave a
        // buyer paying more than catalog on stock the deal didn't consume.
        const overridePct = Number(bundle?.overridePct);
        const hasOverride = overridePct > 0 && overridePct < 100;
        if (hasOverride) {
          for (const l of matchingLines) {
            const overridePrice = l.retailPrice * (1 - overridePct / 100);
            // Beyond-deal units: promo rate, floored at catalog.
            l.wholesalePrice = Math.min(l.wholesalePrice, overridePrice);
            // Deal-paid units: the promo rate itself, deliberately NOT floored
            // at catalog — catalog plus a free unit is the loss-making stack.
            // A line can match several bundles, so keep the cheapest.
            l.dealPaidPrice =
              l.dealPaidPrice === null ? overridePrice : Math.min(l.dealPaidPrice, overridePrice);
          }
        }

        // Units a group consumes get no catalog discount: the free item IS the
        // discount, so the paid portion sits at full retail unless an override
        // says otherwise. Only units beyond the groups keep the wholesale
        // price. Free units come off the cheapest matching line first, matching
        // Shopify's own BXGY convention.
        let freeRemaining = groups * getQty;
        let dealPaidRemaining = groups * buyQty;
        if (freeRemaining <= 0) continue;

        const sortedLines = [...matchingLines].sort((a, b) => a.wholesalePrice - b.wholesalePrice);

        for (const l of sortedLines) {
          let available = l.quantity - l.freeQty - l.dealPaidQty;
          if (available <= 0) continue;

          const freeFromThisLine = Math.min(freeRemaining, available);
          l.freeQty += freeFromThisLine;
          freeRemaining -= freeFromThisLine;
          available -= freeFromThisLine;

          const dealPaidFromThisLine = Math.min(dealPaidRemaining, available);
          l.dealPaidQty += dealPaidFromThisLine;
          dealPaidRemaining -= dealPaidFromThisLine;
        }
      }
    }
  }

  // ── One candidate per price tier on a line ────────────────────────────────
  // Each becomes its own discount row, so checkout and the admin order show
  // "1 @ $0 free, 5 @ deal price, 1 @ wholesale" rather than a blended average.
  // Plain lines were already emitted above; this only covers deal lines.
  for (const l of lines) {
    const wholesaleQty = l.quantity - l.freeQty - l.dealPaidQty;

    if (l.freeQty > 0) {
      candidates.push({
        targets: [{ cartLine: { id: l.id, quantity: l.freeQty } }],
        value: { fixedAmount: { amount: l.retailPrice.toFixed(2), appliesToEachItem: true } },
        message: "Buy X Get Y Free",
      });
    }

    // Deal-paid and beyond-deal units are priced by different rules, so they
    // are separate tiers; they share one row only when they land on the same
    // price, which avoids two identical-looking lines.
    const dealPaidPrice = l.dealPaidPrice === null ? l.retailPrice : l.dealPaidPrice;
    const samePrice = Math.abs(dealPaidPrice - l.wholesalePrice) < 0.005;

    if (samePrice) {
      const qty = l.dealPaidQty + wholesaleQty;
      if (qty > 0 && l.wholesalePrice < l.retailPrice - MIN_DISCOUNT) {
        candidates.push({
          targets: [{ cartLine: { id: l.id, quantity: qty } }],
          value: { fixedAmount: { amount: (l.retailPrice - l.wholesalePrice).toFixed(2), appliesToEachItem: true } },
          message: "B2B Wholesale Price",
        });
      }
    } else {
      if (l.dealPaidQty > 0 && dealPaidPrice < l.retailPrice - MIN_DISCOUNT) {
        candidates.push({
          targets: [{ cartLine: { id: l.id, quantity: l.dealPaidQty } }],
          value: { fixedAmount: { amount: (l.retailPrice - dealPaidPrice).toFixed(2), appliesToEachItem: true } },
          message: "Deal Price",
        });
      }
      if (wholesaleQty > 0 && l.wholesalePrice < l.retailPrice - MIN_DISCOUNT) {
        candidates.push({
          targets: [{ cartLine: { id: l.id, quantity: wholesaleQty } }],
          value: { fixedAmount: { amount: (l.retailPrice - l.wholesalePrice).toFixed(2), appliesToEachItem: true } },
          message: "B2B Wholesale Price",
        });
      }
    }
  }

  if (!candidates.length) return noDiscount;

  return {
    operations: [
      {
        productDiscountsAdd: {
          // ALL: every candidate applies. Each targets its own line and
          // quantity band, so they do not compete.
          candidates,
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
