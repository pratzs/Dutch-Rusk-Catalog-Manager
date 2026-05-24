(function () {
  const _el = document.getElementById("catalog-variant-hider-data");
  const APP_URL     = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = (_el && _el.dataset.customerId) || null;
  const SHOP        = (_el && _el.dataset.shop) || window.Shopify?.shop || null;

  const rulesCache = {};

  async function fetchRules(locationId, productId) {
    const cacheKey = `${locationId || CUSTOMER_ID}::${productId || ""}`;
    if (rulesCache[cacheKey]) return rulesCache[cacheKey];
    
    // Aggressive Cache Busting
    const timestamp = Date.now();
    
    try {
      const params = new URLSearchParams();
      if (locationId) { params.set("locationId", locationId); }
      if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
      if (productId) params.set("productId", productId);
      params.set("_t", timestamp);
      
      const res  = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      const data = await res.json();
      if (Array.isArray(data.hiddenVariantTypes)) rulesCache[cacheKey] = data;
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

    // ── Full Reset ──────────────────────────────────────────────────────────
    // Un-hide everything before applying new rules to prevent stale state.
    container.querySelectorAll('[style*="display: none"]').forEach(el => {
        if (el.style.display === "none") el.style.removeProperty("display");
    });

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
      
      // Normalize string comparisons completely
      const valLower = val.trim().toLowerCase();

      // Guard: Protect standalone baseline units
      if (valLower === "outer" || valLower === "each" || valLower === "packet") return false;

      // Check against all rule configurations safely
      return validTypes.some(t => {
        const cleanType = t.trim().toLowerCase();
        return valLower === cleanType || valLower.includes(cleanType) || cleanType.includes(valLower);
      }) || validIds.some(id => valLower === id.trim().toLowerCase());
    };

    const visibleVariantEls = allVariantEls.filter(el => {
        const val = elText(el);
        if (!val || /^[-–—]|select|choose/i.test(val)) return false;
        return !isBlockedEl(el);
    });

    // ── Selection Correction ───────────────────────────────────────────────
    const currentlySelected = allVariantEls.find(el => {
        if (el.tagName === "OPTION") return el.selected;
        if (el.type === "radio") return el.checked;
        return false;
    });

    if (currentlySelected && isBlockedEl(currentlySelected) && visibleVariantEls.length > 0) {
        console.log("[CVH] Selection Correction Triggered.");
        const target = visibleVariantEls[0];
        if (target.tagName === "OPTION") {
            target.selected = true;
            target.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (target.type === "radio") {
            target.click();
        }
    }

    const hideVariantEl = (el) => {
      el.style.setProperty("display", "none", "important");
      if (el.id) {
        const lbl = container.querySelector(`label[for="${el.id}"]`);
        if (lbl) lbl.style.setProperty("display", "none", "important");
      }
      const wrap = el.closest(".swatch-element, .variant-input, li, .option__item");
      if (wrap && !wrap.classList.contains("grid__item")) {
        wrap.style.setProperty("display", "none", "important");
      }
    };

    allVariantEls.filter(isBlockedEl).forEach(hideVariantEl);
    
    injectStrikethroughPricing(container);
  }

  async function init() {
    const el = document.getElementById("catalog-variant-hider-data") || document.querySelector("[data-location-id]");
    if (!el) return;

    const singleProductId = el.dataset.productId || null;
    let resolvedLocationId = LOCATION_ID;

    if (!resolvedLocationId) {
      try {
        const cartData = await (await fetch("/cart.js")).json();
        resolvedLocationId = cartData?.company_location?.id || cartData?.buyer_identity?.company_location?.id || null;
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
      const blanketRules = await fetchRules(resolvedLocationId, "");
      const processBatch = async () => {
        const pidElements = Array.from(document.querySelectorAll("[data-product-id]:not([data-cvh-seen])"));
        if (pidElements.length === 0) return;
        pidElements.forEach(el => el.setAttribute("data-cvh-seen", "1"));
        
        await Promise.all(pidElements.map(async (pidEl) => {
            const pid = pidEl.dataset.productId;
            const container = pidEl.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, article") || pidEl;
            let fullPid = pid;
            if (fullPid && !fullPid.includes("/")) fullPid = `gid://shopify/Product/${fullPid}`;
            const rules = await fetchRules(resolvedLocationId, fullPid);
            applyRulesToContainer(container, rules);
        }));
      };
      processBatch();
      new MutationObserver(processBatch).observe(document.body, { childList: true, subtree: true });
    }

    function watchCollectionGrid() {
      const gridContainer = document.querySelector('.product-grid, #product-grid, main, #MainContent');
      if (!gridContainer) return;

      const observer = new MutationObserver((mutations) => {
        let shouldRun = false;
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            shouldRun = true;
            break;
          }
        }
        if (shouldRun) {
          document.querySelectorAll('.grid-product, .card-wrapper, .product-card, [data-cvh-processed]').forEach(container => {
            if (typeof rulesCache !== 'undefined') {
              const prodId = container.dataset.productId || container.querySelector('[data-product-id]')?.dataset.productId;
              const cacheKey = `${resolvedLocationId || CUSTOMER_ID}::${prodId || ""}`;
              if (rulesCache[cacheKey]) {
                applyRulesToContainer(container, rulesCache[cacheKey]);
              }
            }
          });
        }
      });

      observer.observe(gridContainer, { childList: true, subtree: true });
    }
    watchCollectionGrid();
  }
  init();
})();
