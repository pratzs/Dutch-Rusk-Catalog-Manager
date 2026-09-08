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
// Two things Shopify cannot do for us remain:
//   1. Hide the "Special Deals" menu item from catalogs no deal targets.
//   2. Show a struck-through retail price for variants with no compare-at
//      price set, which the theme has nothing to render a "was" price from.
(function () {
  const LOG = (...a) => console.log("[CVH]", ...a);
  const WARN = (...a) => console.warn("[CVH]", ...a);

  const _el = document.getElementById("catalog-variant-hider-data");
  if (!_el) return; // not a B2B customer; the snippet renders nothing

  const APP_URL = _el.dataset.appUrl || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = _el.dataset.locationId ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = _el.dataset.customerId || null;
  const SHOP = _el.dataset.shop || window.Shopify?.shop || null;

  LOG("loaded", { LOCATION_ID, CUSTOMER_ID, SHOP });

  // ── "Special Deals" menu gate ─────────────────────────────────────────────
  // catalog-hider.liquid hides the menu item for every B2B buyer up front; this
  // is the only thing that reveals it, and only for a buyer whose catalog an
  // actual deal targets. Deliberately one-directional: a buyer who cannot get a
  // deal must never see the link, not even for a frame, and if the app cannot
  // be reached the item simply stays hidden.
  //
  // Cached for half an hour because deal scoping changes rarely, so this is a
  // few requests per buyer per day rather than one per page view.
  const DEALS_KEY = "cvh4deals:" + (CUSTOMER_ID || LOCATION_ID || "");
  const DEALS_TTL_MS = 30 * 60 * 1000;

  // A different buyer must never inherit the previous one's answer.
  try {
    const prev = localStorage.getItem("cvh4deals:who");
    if (prev !== (CUSTOMER_ID || LOCATION_ID || "")) {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("cvh4deals:"))
        .forEach((k) => localStorage.removeItem(k));
    }
    localStorage.setItem("cvh4deals:who", CUSTOMER_ID || LOCATION_ID || "");
  } catch (_) {
    /* private mode or quota */
  }

  function revealDeals() {
    document.documentElement.classList.add("cvh-deals-ok");
  }

  function dealsCacheRead() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DEALS_KEY) || "null");
      return typeof parsed?.eligible === "boolean" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async function fetchWithRetry(url, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) return res;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
    throw lastErr;
  }

  async function applyDealsMenuGate() {
    const cached = dealsCacheRead();
    // Show it straight away on a repeat visit, before the network call, so an
    // eligible buyer does not watch the menu item pop in on every page.
    if (cached?.eligible) revealDeals();
    if (cached && Date.now() - cached.at < DEALS_TTL_MS) return;
    if (!SHOP || !LOCATION_ID) return;

    try {
      const url =
        `${APP_URL}/api/catalog-rules?dealsOnly=1&shop=${encodeURIComponent(SHOP)}` +
        `&locationId=${encodeURIComponent(LOCATION_ID)}`;
      const res = await fetchWithRetry(url);
      if (!res || !res.ok) return;
      const data = await res.json();
      // null means the app could not work it out. Keep the last known answer
      // rather than flipping the menu on a shrug.
      if (typeof data?.dealsEligible !== "boolean") return;

      try {
        localStorage.setItem(DEALS_KEY, JSON.stringify({ eligible: data.dealsEligible, at: Date.now() }));
      } catch (_) {
        /* quota */
      }
      if (data.dealsEligible) revealDeals();
      else document.documentElement.classList.remove("cvh-deals-ok");
      LOG("Special Deals menu:", data.dealsEligible ? "shown" : "hidden (no deals for this catalog)");
    } catch (e) {
      WARN("deals menu gate failed, leaving menu hidden:", e && e.message);
    }
  }

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

  applyDealsMenuGate();

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
