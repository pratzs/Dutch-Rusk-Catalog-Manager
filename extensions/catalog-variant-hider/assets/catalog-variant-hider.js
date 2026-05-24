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

    // 1. Full Layout Reset: Clear stale states safely
    container.querySelectorAll('[style*="display: none"]').forEach(el => {
      if (el.style.display === "none") el.style.removeProperty("display");
    });

    if (validTypes.length === 0 && validIds.length === 0) {
      injectStrikethroughPricing(container);
      return;
    }
    container.setAttribute("data-cvh-processed-final", "1");

    // 2. Target ALL structural and visual labels inside the card/form context
    const genericLabels = container.querySelectorAll('label, .variant-pill, [for]');

    genericLabels.forEach(label => {
      // Extract text safely, accounting for deep inner span text overrides
      const innerTextSpan = label.querySelector('.swatch-input__label-inner, .variant-pill-label');
      const rawText = (innerTextSpan ? innerTextSpan.textContent : label.textContent || "").trim().toLowerCase();
      
      if (!rawText) return;

      // Absolute Safety Guard: Never hide baseline sales units
      if (rawText === "outer" || rawText === "each" || rawText === "packet") return;

      // 3. ENHANCED NORMALIZATION: Normalize strings by dropping numbers and spaces (e.g., "shipper (12 outer)" -> "shipper")
      const normalizedText = rawText.replace(/\s+/g, '').replace(/[^a-z]/g, '');

      const shouldHide = validTypes.some(t => {
        const cleanRule = t.trim().toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '');
        
        // Check for direct matching or core unit keyword overlaps
        if (normalizedText.includes(cleanRule) || cleanRule.includes(normalizedText)) return true;
        if (cleanRule.includes('shipper') && normalizedText.includes('shipper')) return true;
        if (cleanRule.includes('bag') && normalizedText.includes('bag')) return true;
        return false;
      }) || validIds.some(id => rawText.includes(id.trim().toLowerCase()));

      if (shouldHide) {
        // Forcibly hide the entire visual option box wrapper card
        label.style.setProperty("display", "none", "important");
        
        // Find and hide companion radio input nodes or checking dots instantly
        const inputId = label.getAttribute('for');
        const companionInput = inputId ? container.querySelector(`#${inputId}`) : label.querySelector('input');
        if (companionInput) {
          companionInput.style.setProperty("display", "none", "important");
        }
      }
    });

    // 4. SELECTION STATE MANAGEMENT ENGINE
    // Auto-select the baseline "Outer" choice if the theme defaulted to a hidden layout option
    const activeSelectedRadio = container.querySelector('input[type="radio"]:checked');
    if (activeSelectedRadio) {
      const parentLabelWrapper = container.querySelector(`label[for="${activeSelectedRadio.id}"]`) || activeSelectedRadio.closest('label');
      if (parentLabelWrapper && parentLabelWrapper.style.display === 'none') {
        
        const openAlternatives = Array.from(genericLabels).filter(lbl => {
          const txt = lbl.textContent.toLowerCase();
          return lbl.style.display !== 'none' && !txt.includes('select') && !txt.includes('choose');
        });

        if (openAlternatives.length > 0) {
          const targetLabel = openAlternatives[0];
          const targetInput = container.querySelector(`#${targetLabel.getAttribute('for')}`) || targetLabel.querySelector('input');
          if (targetInput) {
            targetInput.checked = true;
            targetInput.click();
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
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
      } else {
        fetchRules(LOCATION_ID, prodId).then(rules => {
          if (rules) {
            applyRulesToContainer(container, rules);
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
