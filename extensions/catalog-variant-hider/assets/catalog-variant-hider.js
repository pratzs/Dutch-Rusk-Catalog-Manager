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

    // 1. Full structural reset
    container.querySelectorAll('[style*="display: none"]').forEach(el => {
        if (el.style.display === "none") el.style.removeProperty("display");
    });

    if (validTypes.length === 0 && validIds.length === 0) {
      injectStrikethroughPricing(container);
      return;
    }
    container.setAttribute("data-cvh-processed", "1");

    // Determine if we are processing the Main Product Page or a Collection Grid Card
    const isProductPage = !!document.querySelector('.product__info-container, .product-single');

    if (isProductPage && container.matches('.product__info-container, .product-form')) {
      // ── SURGICAL PRODUCT PAGE TARGETING ──────────────────────────────────
      // Target the specific radio wrapper label pills on the main product view
      const variantPills = container.querySelectorAll('label.variant-pill');
      
      variantPills.forEach(label => {
        const labelText = (label.textContent || "").trim().toLowerCase();
        
        const shouldHide = validTypes.some(t => labelText.includes(t.toLowerCase())) ||
                           validIds.some(id => labelText.includes(id.toLowerCase()));
                           
        // Strict Protection Guard: Never hide the standalone "Outer" baseline unit
        if (labelText === "outer") return;

        if (shouldHide) {
          label.style.setProperty("display", "none", "important");
          // Also hide the hidden radio dot inside it
          const innerInput = label.querySelector('input');
          if (innerInput) innerInput.style.setProperty("display", "none", "important");
        }
      });

    } else {
      // ── SURGICAL COLLECTION GRID TARGETING ───────────────────────────────
      // On the collection page, target the grid's explicit pill list items
      const gridPills = container.querySelectorAll('.variant-pills-wrapper label.variant-pill, input[type="radio"]');
      
      gridPills.forEach(el => {
        const valText = (el.tagName === "LABEL" ? el.textContent : el.value || "").trim().toLowerCase();
        
        const shouldHide = validTypes.some(t => valText.includes(t.toLowerCase())) ||
                           validIds.some(id => valText.includes(id.toLowerCase()));

        if (valText === "outer") return;

        if (shouldHide) {
          if (el.tagName === "LABEL") {
            el.style.setProperty("display", "none", "important");
          } else {
            el.style.setProperty("display", "none", "important");
            const parentLabel = el.closest('label.variant-pill, .variant-pill');
            if (parentLabel) parentLabel.style.setProperty("display", "none", "important");
          }
        }
      });
    }

    // ── SELECTION CORRECTION ENGINE ────────────────────────────────────────
    // Auto-select the first visible "Outer" variant if the theme defaulted to a hidden one
    const allPills = Array.from(container.querySelectorAll('label.variant-pill'));
    const visiblePills = allPills.filter(lbl => lbl.style.display !== 'none');

    const currentlySelectedInput = container.querySelector('input[type="radio"]:checked');
    if (currentlySelectedInput && currentlySelectedInput.closest('label')?.style.display === 'none' && visiblePills.length > 0) {
      console.log("[CVH] Selection Correction Triggered.");
      const targetLabel = visiblePills[0];
      const targetInput = targetLabel.querySelector('input') || document.getElementById(targetLabel.getAttribute('for'));
      if (targetInput) {
        targetInput.checked = true;
        targetInput.click();
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

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
