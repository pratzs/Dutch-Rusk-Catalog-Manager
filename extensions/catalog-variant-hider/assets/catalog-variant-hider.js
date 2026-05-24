(function () {
  const _el = document.getElementById("catalog-variant-hider-data");
  const APP_URL     = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = (_el && _el.dataset.customerId) || null;
  const SHOP        = (_el && _el.dataset.shop) || window.Shopify?.shop || null;

  const rulesCache = {};
  const SS_PRE = "cvh3:" + (CUSTOMER_ID || LOCATION_ID || "") + ":";

  try {
    const prev = sessionStorage.getItem("cvh3:who");
    if (prev !== (CUSTOMER_ID || LOCATION_ID || "")) {
      Object.keys(sessionStorage).filter(k => k.startsWith("cvh3:")).forEach(k => sessionStorage.removeItem(k));
    }
    sessionStorage.setItem("cvh3:who", CUSTOMER_ID || LOCATION_ID || "");
  } catch (_) {}

  async function fetchRules(locationId, productId) {
    // Normalise productId so GID and numeric IDs share the same cache slot
    const normPid = productId
      ? (String(productId).includes("/") ? String(productId).split("/").pop() : String(productId))
      : "";
    const cacheKey = `${locationId || CUSTOMER_ID}::${normPid}`;
    if (rulesCache[cacheKey]) return rulesCache[cacheKey];
    const ssKey = SS_PRE + (normPid || "__blanket");
    try {
      const s = sessionStorage.getItem(ssKey);
      if (s) { const d = JSON.parse(s); if (Array.isArray(d.hiddenVariantTypes)) { rulesCache[cacheKey] = d; return d; } }
    } catch (_) {}
    try {
      const params = new URLSearchParams();
      if (locationId) params.set("locationId", locationId);
      if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
      if (productId) params.set("productId", productId);
      params.set("_t", Date.now());
      const res  = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      const data = await res.json();
      if (Array.isArray(data.hiddenVariantTypes)) {
        rulesCache[cacheKey] = data;
        try { sessionStorage.setItem(ssKey, JSON.stringify(data)); } catch (_) {}
      }
      return data;
    } catch (_) {
      return { hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false };
    }
  }

  function injectStrikethroughPricing(container) {
    const globalRetailPrice = _el ? _el.dataset.standardRetailPrice : null;
    const retailEl = container.querySelector("[data-standard-retail-price], .cvh-retail-price");
    const retailPrice = parseFloat(container.dataset.standardRetailPrice || globalRetailPrice || retailEl?.dataset.standardRetailPrice || retailEl?.value || "0");

    if (!retailPrice) return;
    const priceEl = container.querySelector(".price-item--regular, .product__price, .grid-product__price, .price__container, [data-price], .current-price");
    if (!priceEl || priceEl.querySelector(".cvh-strikethrough")) return;

    const activePriceText = (priceEl.textContent || "").replace(/[^0-9.]/g, "");
    const activePrice = parseFloat(activePriceText);

    if (retailPrice > activePrice + 0.01) {
      const currencySymbol = (priceEl.textContent || "").trim().charAt(0) === "$" ? "$" : "";
      const strikethrough = document.createElement("span");
      strikethrough.className = "cvh-strikethrough";
      strikethrough.style.cssText = "text-decoration: line-through; color: #8c8c8c; margin-right: 8px; font-weight: normal;";
      strikethrough.textContent = `${currencySymbol}${retailPrice.toFixed(2)}`;
      priceEl.prepend(strikethrough);
    }
  }

  function applyRulesToContainer(container, rules) {
    const validTypes = rules.hiddenVariantTypes || [];
    const validIds   = rules.hiddenVariantIds   || [];

    if (validTypes.length === 0 && validIds.length === 0) {
      injectStrikethroughPricing(container);
      return;
    }

    container.setAttribute("data-cvh-processed", "1");

    const allVariantEls = Array.from(
      container.querySelectorAll('input[type="radio"], option, button[data-variant-id], .variant-input input, label[data-value]')
    );

    const elText = (el) => {
      if (el.tagName === "OPTION") return (el.textContent || el.value || "").trim();
      if (el.tagName === "BUTTON") return (el.textContent || el.getAttribute("aria-label") || "").trim();
      if (el.tagName === "LABEL" && el.dataset.value) return el.dataset.value.trim();
      const val = (el.value || "").trim();
      if ((el.type === "radio" || el.type === "checkbox") && /^\d{8,}$/.test(val)) {
        const lbl = el.id ? container.querySelector(`label[for="${el.id}"]`) : el.closest("label");
        const labelText = lbl ? lbl.textContent.trim() : "";
        if (labelText) return labelText;
      }
      return val || (el.textContent || "").trim();
    };

    const isBlockedEl = (el) => {
      const val = elText(el);
      if (!val) return false;
      const valLower = val.toLowerCase();
      return validTypes.some(t => valLower.startsWith(t.toLowerCase())) ||
             validIds.some(id => valLower === id.toLowerCase());
    };

    const hideVariantEl = (el) => {
      el.style.setProperty("display", "none", "important");
      if (el.id) {
        const lbl = container.querySelector(`label[for="${el.id}"]`);
        if (lbl) lbl.style.setProperty("display", "none", "important");
      }
      const wrap = el.closest(".swatch-element, .variant-input, li, .option__item");
      if (wrap && !wrap.classList.contains("grid__item") && !wrap.classList.contains("product-form__input")) {
        wrap.style.setProperty("display", "none", "important");
      }
    };

    const sweepBlockedLabels = () => {
      container.querySelectorAll(
        "label, option, .swatch-element, [class*='option__label'], [class*='variant-label']," +
        "[class*='swatch-label'], [class*='option-value'], [data-option-value], [data-value]"
      ).forEach(el => {
        if (el.style.display === "none") return;
        if (isBlockedEl(el)) {
          el.style.setProperty("display", "none", "important");
          const wrap = el.closest(".swatch-element, .variant-input, li, .option__item");
          if (wrap && !wrap.classList.contains("grid__item")) {
            wrap.style.setProperty("display", "none", "important");
          }
        }
      });
    };

    const blockedEls = allVariantEls.filter(isBlockedEl);
    blockedEls.forEach(hideVariantEl);
    sweepBlockedLabels();

    // Auto-select a visible variant if the currently selected one is now hidden
    const checkedRadio = container.querySelector('input[type="radio"]:checked');
    if (checkedRadio && isBlockedEl(checkedRadio)) {
      const firstVisible = allVariantEls.find(el => el.type === "radio" && !isBlockedEl(el));
      if (firstVisible) {
        firstVisible.checked = true;
        firstVisible.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    injectStrikethroughPricing(container);
  }

  async function init() {
    const el = document.getElementById("catalog-variant-hider-data") || document.querySelector("[data-location-id]");
    if (!el) return;
    if (!LOCATION_ID && !CUSTOMER_ID) return;

    const singleProductId = el.dataset.productId || null;
    let resolvedLocationId = LOCATION_ID;

    if (!resolvedLocationId) {
      try {
        const cartData = await (await fetch("/cart.js")).json();
        resolvedLocationId = cartData?.company_location?.id || cartData?.buyer_identity?.company_location?.id || null;
      } catch (_) {}
    }

    if (singleProductId) {
      // ── PRODUCT PAGE ────────────────────────────────────────────────────────
      // Fetch rules WITH productId so product-specific overrides are respected.
      const rules = await fetchRules(resolvedLocationId, singleProductId);

      const applyAll = () => {
        const seen = new WeakSet();

        // Try increasingly broad containers to handle any theme structure.
        // Priority: specific product form elements → section wrapper → full main content.
        const specificSelectors = [
          "product-form",
          "variant-selects",
          ".product-form",
          ".product__info-container",
          ".product__info-wrapper",
          "#product-info",
          ".product-single__meta",
          ".product-template",
          "#main-product",
          ".product-single",
          ".product-section",
          ".product",
        ].join(", ");

        document.querySelectorAll(specificSelectors).forEach(c => {
          if (seen.has(c)) return;
          seen.add(c);
          applyRulesToContainer(c, rules);
        });

        // Always also apply to the main content area as a catch-all so that
        // no matter what class/id the theme uses, we never miss the form.
        const main = document.querySelector("#MainContent, main, [role='main']") || document.body;
        if (!seen.has(main)) {
          seen.add(main);
          applyRulesToContainer(main, rules);
        }
      };

      applyAll();
      new MutationObserver(applyAll).observe(document.body, { childList: true, subtree: true });

    } else {
      // ── COLLECTION / LIST PAGE ───────────────────────────────────────────────
      // Fetch PER-PRODUCT rules (with productId) so that catalog overrides
      // (e.g. "show Shipper for Twix even though catalog hides Shipper") are
      // respected on the collection grid, not just on the product page.
      const processBatch = async () => {
        const pidElements = Array.from(document.querySelectorAll("[data-product-id]:not([data-cvh-seen])"));
        if (pidElements.length === 0) return;
        // Mark immediately to prevent duplicate processing on rapid mutations
        pidElements.forEach(el => el.setAttribute("data-cvh-seen", "1"));

        // Fire all per-product fetches in parallel.
        // Session storage caches results so subsequent pages are instant.
        await Promise.all(pidElements.map(async (el) => {
          const productId = el.dataset.productId;
          const card = el.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, article") || el;
          try {
            const rules = await fetchRules(resolvedLocationId, productId);
            applyRulesToContainer(card, rules);
          } catch (_) {}
        }));
      };

      await processBatch();
      new MutationObserver(processBatch).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
