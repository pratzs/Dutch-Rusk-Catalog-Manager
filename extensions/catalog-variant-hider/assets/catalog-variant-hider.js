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
      
      // Strip trailing whitespace and normalize lowercase structures completely
      const valLower = val.trim().toLowerCase().replace(/\s+/g, ' ');

      // Guard: Absolutely protect your target baseline distribution units
      if (valLower === "outer" || valLower === "each" || valLower === "packet") return false;

      // 1. Direct validation check loop
      const isDirectMatch = validTypes.some(t => {
        const cleanType = t.trim().toLowerCase().replace(/\s+/g, ' ');
        return valLower === cleanType || valLower.includes(cleanType) || cleanType.includes(valLower);
      }) || validIds.some(id => valLower === id.trim().toLowerCase());

      if (isDirectMatch) return true;

      // 2. Keyword Split Verification (Fixes partial template renders like matching "Shipper" from "Shipper (12 Outer)")
      return validTypes.some(t => {
        const cleanType = t.trim().toLowerCase();
        // Catch core identifiers safely (e.g., if rule contains 'shipper' and element string contains 'shipper')
        if (cleanType.includes('shipper') && valLower.includes('shipper')) return true;
        if (cleanType.includes('bag') && valLower.includes('bag')) return true;
        return false;
      });
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
      // Hide the element itself
      el.style.setProperty("display", "none", "important");
      
      // FIX: If the element is an input inside a custom theme label block, hide the parent label pill
      const parentLabel = el.closest('label.variant-pill, .variant-pill');
      if (parentLabel) {
        parentLabel.style.setProperty("display", "none", "important");
      }

      // Fallback label checks via IDs
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

  // ── FAULT-TOLERANT EXECUTION SANDBOX ENGINE ─────────────────────────────
  function processSingleCard(container) {
    try {
      if (!container || container.hasAttribute('data-cvh-processed-final')) return;

      const prodId = container.dataset.productId || container.querySelector('[data-product-id]')?.dataset.productId;
      if (!prodId) return;

      const cacheKey = `${LOCATION_ID || CUSTOMER_ID}::${prodId}`;

      if (typeof rulesCache !== 'undefined' && rulesCache[cacheKey]) {
        applyRulesToContainer(container, rulesCache[cacheKey]);
        container.setAttribute('data-cvh-processed-final', '1');
      } else {
        fetchRules(LOCATION_ID, prodId).then(rules => {
          if (rules) {
            applyRulesToContainer(container, rules);
            container.setAttribute('data-cvh-processed-final', '1');
          }
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("[CVH] Intercepted template rendering block bypass:", err);
    }
  }

  function monitorInfiniteScroll() {
    try {
      // Catch product wrappers on the detail page as well as standard grid components
      const mainView = document.querySelector('.product-grid, #product-grid, [data-section], main, #MainContent') || document.body;
      
      // Initial baseline sweep
      document.querySelectorAll('.grid-product, .card-wrapper, .product-card, .product__info-container, .product-form').forEach(processSingleCard);

      const continuousObserver = new MutationObserver((mutations) => {
        try {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue;

              if (node.matches('.grid-product, .card-wrapper, .product-card, .product__info-container, .product-form')) {
                processSingleCard(node);
              } else {
                node.querySelectorAll('.grid-product, .card-wrapper, .product-card, .product__info-container, .product-form').forEach(processSingleCard);
              }
            }
          }
        } catch (observerErr) {
          // Silent catch to prevent cascade thread halts
        }
      });

      continuousObserver.observe(mainView, { childList: true, subtree: true });
    } catch (err) {
      console.error("[CVH Core] Observers faulted out:", err);
    }
  }

  async function init() {
    const el = document.getElementById("catalog-variant-hider-data") || document.querySelector("[data-location-id]");
    if (!el) return;

    // Run the infinite scroll watcher loop across the document lifecycle
    monitorInfiniteScroll();
  }

  // Trigger app framework execution
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
