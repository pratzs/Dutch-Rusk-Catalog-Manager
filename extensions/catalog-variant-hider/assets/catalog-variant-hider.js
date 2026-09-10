// B2B storefront helpers for Dutch Rusk.
//
// This file used to be 900 lines of variant hiding: fetch the buyer's catalog
// rules from the app, mask every variant picker until they arrived, hide the
// pack sizes they may not order, and mark a card "Back Soon" when nothing was
// left or when the fetch failed.
//
// All of that is gone. Shopify supports variant-level publishing now, so a pack
// size is excluded from a catalog server-side: the variant is not in the page
// at all, and a product with every variant excluded returns a 404. Verified on
// the live storefront as a TEEG buyer.
//
// That was worth removing rather than repairing. The old path called the app
// once per product card per page view, the app's database is in Oregon while
// the app runs in Singapore, and any slow or failed answer left the card
// reading "Back Soon" on stocked product until the shopper reloaded. Customers
// reported it repeatedly. There is nothing left here to race, fail open, or
// latch.
//
// The catalog rules still exist in the Catalog Manager as the policy;
// api.catalog-variant-sync is what keeps Shopify's exclusions matching them,
// including for products published later.
//
// One thing Shopify cannot do for us remains: show a struck-through retail
// price for variants with no compare-at price set, which the theme has nothing
// to render a "was" price from.
//
// The "Special Deals" menu gate used to live here too. It hid the item with CSS
// and called this app on every page view to decide whether to reveal it, which
// meant the answer arrived after paint and depended on the app being reachable.
// The theme decides it in Liquid now, from the shop's deal_location_ids
// metafield, so an ineligible buyer never has the menu item rendered at all.
// That removed one app request per page view per buyer, and the rule now lives
// in exactly one place instead of two. Entitlement is still driven by the
// Catalog Manager: syncDealLocations() reads which price lists the deals
// actually target and rewrites that metafield hourly.
(function () {
  const LOG = (...a) => console.log("[CVH]", ...a);

  const _el = document.getElementById("catalog-variant-hider-data");
  if (!_el) return; // not a B2B customer; the snippet renders nothing

  const LOCATION_ID = _el.dataset.locationId ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = _el.dataset.customerId || null;
  const SHOP = _el.dataset.shop || window.Shopify?.shop || null;

  LOG("loaded", { LOCATION_ID, CUSTOMER_ID, SHOP });


  // ── Struck-through retail price ───────────────────────────────────────────
  // Only for variants with no compare-at price, which is what the theme needs
  // in order to show a "was" price itself. Where compare-at is set the theme
  // already renders it and this does nothing.
  //
  // The retail figure comes from catalog-hider.liquid. Note the units: the
  // custom.standard_retail_price metafield is a plain decimal, while
  // compare_at_price is in cents. Mixing them was a real bug -- the metafield
  // was piped through money_without_currency, so 24.30 came out as 0.24, below
  // every real price, and no strikethrough was ever drawn.
  function injectStrikethroughPricing(container) {
    const retailPrice = parseFloat(
      container.dataset.standardRetailPrice || _el.dataset.standardRetailPrice || "0"
    );
    if (!retailPrice) return;

    const priceEl = container.querySelector(
      ".price-item--regular, .product__price, .grid-product__price, .price__container, [data-price], .current-price"
    );
    if (!priceEl || priceEl.querySelector(".cvh-strikethrough")) return;

    // If the theme is already showing a struck-through price, adding another
    // would show two.
    if (priceEl.closest(".price--on-sale, .price__sale")) return;

    const activePrice = parseFloat((priceEl.textContent || "").replace(/[^0-9.]/g, ""));
    if (!isFinite(activePrice)) return;

    if (retailPrice > activePrice + 0.01) {
      const currencySymbol = (priceEl.textContent || "").trim().charAt(0) === "$" ? "$" : "";
      const strikethrough = document.createElement("span");
      strikethrough.className = "cvh-strikethrough";
      strikethrough.style.cssText =
        "text-decoration: line-through; color: #8c8c8c; margin-right: 8px; font-weight: normal;";
      strikethrough.textContent = `${currencySymbol}${retailPrice.toFixed(2)}`;
      priceEl.prepend(strikethrough);
    }
  }

  function applyPricing() {
    if (_el.dataset.productId) {
      const main = document.querySelector("main") || document.body;
      injectStrikethroughPricing(main);
      return;
    }
    // Collection cards carry their own retail price when the theme provides it.
    document.querySelectorAll("[data-standard-retail-price]:not([data-cvh-priced])").forEach((card) => {
      card.setAttribute("data-cvh-priced", "1");
      injectStrikethroughPricing(card);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyPricing);
  } else {
    applyPricing();
  }

  // Cards arriving from infinite scroll still want a "was" price. Nothing here
  // can mark a product unavailable, so a late or missed pass costs a
  // strikethrough at worst, never a lost sale.
  new MutationObserver(applyPricing).observe(document.body, { childList: true, subtree: true });
})();
