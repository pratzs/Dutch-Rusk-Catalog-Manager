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
    const cacheKey = `${locationId || CUSTOMER_ID}::${productId || ""}`;
    if (rulesCache[cacheKey]) return rulesCache[cacheKey];
    const ssKey = SS_PRE + (productId || "__blanket");
    try {
      const s = sessionStorage.getItem(ssKey);
      if (s) { const d = JSON.parse(s); if (Array.isArray(d.hiddenVariantTypes)) { rulesCache[cacheKey] = d; return d; } }
    } catch (_) {}
    try {
      const params = new URLSearchParams();
      if (locationId) { params.set("locationId", locationId); }
      if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
      if (productId) params.set("productId", productId);
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
      const valLower = val.toLowerCase();
      const isBlocked = validTypes.some(t => valLower.startsWith(t.toLowerCase())) || 
                        validIds.some(id => valLower.startsWith(id.toLowerCase()));
      
      // LOG EVERY CHECK
      if (val) console.log(`[CVH] Checking element "${val}": Blocked=${isBlocked}`);
      return isBlocked;
    };

    const blockedEls = allVariantEls.filter(isBlockedEl);

    const isPlaceholder = (el) => {
      const val = elText(el);
      return val === "" || /^[-–—]|select|choose/i.test(val);
    };
    const realVariantEls    = allVariantEls.filter(el => !isPlaceholder(el));
    const hasNonBlockedOpt  = realVariantEls.length > 0 && realVariantEls.some(el => !isBlockedEl(el));

    const hideVariantEl = (el) => {
      el.style.setProperty("display", "none", "important");
      if (el.id) {
        const lbl = container.querySelector(`label[for="${el.id}"]`);
        if (lbl) lbl.style.setProperty("display", "none", "important");
      }
      const wrap = el.closest(".swatch-element, .variant-input, li, .option__item, .product-form__input");
      if (wrap && !wrap.classList.contains("grid__item")) {
        wrap.style.setProperty("display", "none", "important");
      }
    };

    const sweepBlockedLabels = () => {
      container.querySelectorAll("label, option, .swatch-element, [class*='option__label'], [class*='variant-label'], [class*='swatch-label'], [class*='option-value'], [data-option-value], [data-value]").forEach(el => {
        if (el.style.display === "none") return;
        const val = elText(el);
        const valLower = val.toLowerCase();
        if (val && (validTypes.some(t => valLower.startsWith(t.toLowerCase())) || validIds.some(id => valLower.startsWith(id.toLowerCase())))) {
          el.style.setProperty("display", "none", "important");
          const wrap = el.closest(".swatch-element, .variant-input, li, .option__item, .product-form__input");
          if (wrap && !wrap.classList.contains("grid__item")) {
            wrap.style.setProperty("display", "none", "important");
          }
        }
      });
    };

    if (hasNonBlockedOpt) {
      blockedEls.forEach(hideVariantEl);
      sweepBlockedLabels();
    } else if (realVariantEls.length > 0) {
      const btn = Array.from(container.querySelectorAll('button, [type="submit"], a.btn')).find(b => {
        if (b.name === "add") return true;
        const t = (b.textContent || "").trim().toLowerCase();
        return t.includes("add to cart") || t.includes("add to bag") || t.includes("buy now") || t === "add";
      });
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Back soon";
        btn.style.opacity = "0.5";
        btn.style.setProperty("pointer-events", "none", "important");
      }
      blockedEls.forEach(hideVariantEl);
      sweepBlockedLabels();
    }
    
    injectStrikethroughPricing(container);
  }

  async function init() {
    const el = document.getElementById("catalog-variant-hider-data") || document.querySelector("[data-location-id]");
    if (!el) return;

    console.log("[CVH] Running | Location:", LOCATION_ID, "| Customer:", CUSTOMER_ID);

    const singleProductId = el.dataset.productId || null;
    let resolvedLocationId = LOCATION_ID;

    if (!resolvedLocationId) {
      try {
        const cartData = await (await fetch("/cart.js")).json();
        resolvedLocationId = cartData?.company_location?.id || cartData?.buyer_identity?.company_location?.id || null;
        if (resolvedLocationId) console.log("[CVH] Got locationId from cart.js:", resolvedLocationId);
      } catch (_) {}
    }

    if (singleProductId) {
      const rules = await fetchRules(resolvedLocationId, singleProductId);
      console.log("[CVH] Rules for Product:", rules);
      
      const applyAll = () => {
        const SELECTORS = "#main-product, .product, .product-single, .card, .grid__item, .product-section, .product-item, .product__info-container, article";
        document.querySelectorAll(SELECTORS).forEach(c => applyRulesToContainer(c, rules));
      };

      applyAll();
      new MutationObserver(applyAll).observe(document.body, { childList: true, subtree: true });

    } else {
      const processBatch = async () => {
        const pidElements = Array.from(document.querySelectorAll("[data-product-id]:not([data-cvh-seen])"));
        if (pidElements.length === 0) return;
        pidElements.forEach(el => el.setAttribute("data-cvh-seen", "1"));
        const rules = await fetchRules(resolvedLocationId, "");
        pidElements.forEach(el => {
          const card = el.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, article") || el;
          applyRulesToContainer(card, rules);
        });
      };
      processBatch();
      new MutationObserver(processBatch).observe(document.body, { childList: true, subtree: true });
    }
  }
  init();
})();
