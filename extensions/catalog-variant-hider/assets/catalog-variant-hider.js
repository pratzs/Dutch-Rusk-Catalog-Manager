(function () {
  // APP_URL, locationId, customerId, and shop are injected by the Liquid snippet
  // via data attributes — never hardcoded here.
  const _el = document.getElementById("catalog-variant-hider-data");
  const APP_URL     = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = (_el && _el.dataset.customerId) || null;
  const SHOP        = (_el && _el.dataset.shop) || window.Shopify?.shop || null;

  const rulesCache = {};

  // ── sessionStorage cache (per-customer, per browser session) ───────────
  // Key prefix uses CUSTOMER_ID so a different customer login gets a fresh cache.
  const SS_PRE = "cvh3:" + (CUSTOMER_ID || LOCATION_ID || "") + ":";
  try {
    const prev = sessionStorage.getItem("cvh3:who");
    if (prev !== (CUSTOMER_ID || LOCATION_ID || "")) {
      Object.keys(sessionStorage).filter(k => k.startsWith("cvh3:")).forEach(k => sessionStorage.removeItem(k));
    }
    sessionStorage.setItem("cvh3:who", CUSTOMER_ID || LOCATION_ID || "");
  } catch (_) {}

  // ── API ──────────────────────────────────────────────────────────────────
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
      else if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
      if (productId) params.set("productId", productId);
      const res  = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      const data = await res.json();
      // Only cache valid rule responses — never cache API error objects.
      if (Array.isArray(data.hiddenVariantTypes)) {
        rulesCache[cacheKey] = data;
        try { sessionStorage.setItem(ssKey, JSON.stringify(data)); } catch (_) {}
      }
      return data;
    } catch (_) {
      return { hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false };
    }
  }

  // ── Strikethrough Pricing Helper ─────────────────────────────────────────
  function injectStrikethroughPricing(container) {
    // Find the retail price from:
    // 1. The container's data attributes (collection cards)
    // 2. The global data element (product page)
    // 3. A hidden input/metadata element inside the container
    const globalRetailPrice = _el ? _el.dataset.standardRetailPrice : null;
    const retailEl = container.querySelector("[data-standard-retail-price], .cvh-retail-price");
    
    const retailPrice = parseFloat(
      container.dataset.standardRetailPrice || 
      globalRetailPrice || 
      retailEl?.dataset.standardRetailPrice || 
      retailEl?.value || 
      "0"
    );

    if (!retailPrice) return;

    // Find the active catalog price element (theme dependent selectors)
    const priceEl = container.querySelector(
      ".price-item--regular, .product__price, .grid-product__price, " +
      ".price__container, [data-price], .current-price"
    );
    if (!priceEl || priceEl.querySelector(".cvh-strikethrough")) return;

    const activePriceText = (priceEl.textContent || "").replace(/[^0-9.]/g, "");
    const activePrice = parseFloat(activePriceText);

    if (retailPrice > activePrice) {
      const currencySymbol = (priceEl.textContent || "").trim().charAt(0) === "$" ? "$" : "";
      const strikethrough = document.createElement("span");
      strikethrough.className = "cvh-strikethrough";
      strikethrough.style.cssText = "text-decoration: line-through; color: #8c8c8c; margin-right: 8px; font-weight: normal;";
      strikethrough.textContent = `${currencySymbol}${retailPrice.toFixed(2)}`;
      priceEl.prepend(strikethrough);
    }
  }

  // ── Apply rules to a single container ───────────────────────────────────
  function applyRulesToContainer(container, rules) {
    const validTypes = rules.hiddenVariantTypes || [];
    const validIds   = rules.hiddenVariantIds   || [];

    if (validTypes.length === 0 && validIds.length === 0) {
      injectStrikethroughPricing(container);
      return;
    }

    container.setAttribute("data-cvh-processed", "1");
    const content = container.textContent || "";

    // SKU-based check (product page selected variant)
    const currentSkuEl = container.querySelector(".product__sku, [data-sku]");
    const currentSku   = currentSkuEl ? currentSkuEl.textContent.trim() : "";
    const isForbiddenSkuSelected = validIds.includes(currentSku);

    // ── Classify ALL radio/option elements ───────────────────────────────
    // Intentionally ignore inline style="display:none" here — many themes
    // CSS-hide radio inputs and show styled <label> buttons instead, so
    // :not([style*="none"]) would wrongly return 0 and disable the product.
    const allVariantEls = Array.from(
      container.querySelectorAll('input[type="radio"], option, button[data-variant-id], .variant-input input')
    );

    // For <option> elements el.value is a Shopify numeric variant ID — use textContent.
    // For radio inputs: if value is also a numeric variant ID (collection card pill picker
    // uses value="{{ variant.id }}"), resolve the human-readable label from the wrapping
    // <label> element instead. Otherwise use el.value directly (product page option pickers
    // use value="Outer", value="Shipper", etc.).
    const elText = (el) => {
      if (el.tagName === "OPTION") return (el.textContent || el.value || "").trim();
      if (el.tagName === "BUTTON") return (el.textContent || el.getAttribute("aria-label") || "").trim();
      const val = (el.value || "").trim();
      if ((el.type === "radio" || el.type === "checkbox") && /^\d{8,}$/.test(val)) {
        const lbl = el.id
          ? container.querySelector(`label[for="${el.id}"]`)
          : el.closest("label");
        const labelText = lbl ? lbl.textContent.trim() : "";
        if (labelText) return labelText;
      }
      return val || (el.textContent || "").trim();
    };

    const blockedEls = allVariantEls.filter(el => {
        const val = elText(el);
        const isBlocked = validTypes.some(t => val.startsWith(t)) || validIds.includes(val);
        console.log(`[CVH] Checking element:`, { 
            tag: el.tagName, 
            type: el.type, 
            text: val, 
            isBlocked,
            id: el.id
        });
        return isBlocked;
    });

    // Exclude placeholder / "Select..." options from the non-blocked check.
    // A theme's <select> often has <option value="">Select Pack Size</option> as the
    // first entry — that would wrongly make hasNonBlockedOpt = true and skip the
    // "disable product" branch even when every real option is blocked.
    const isPlaceholder = (el) => {
      const val = elText(el);
      return val === "" || /^[-–—]|select|choose/i.test(val);
    };
    const realVariantEls    = allVariantEls.filter(el => !isPlaceholder(el));
    const hasNonBlockedOpt  = realVariantEls.length > 0 &&
                              realVariantEls.some(el => !isBlockedEl(el));

    // Fallback for collection cards: when no radio/option elements exist (e.g. a
    // single-variant card), check [data-variant-title] hidden inputs injected by
    // the Liquid snippet to determine if ALL variants are blocked.
    const allVariantTitlesBlocked = allVariantEls.length === 0 && (() => {
      const titles = Array.from(container.querySelectorAll("[data-variant-title]"))
        .map(el => (el.dataset.variantTitle || "").trim())
        .filter(t => t && !/^[-–—]|select|choose/i.test(t));
      return titles.length > 0 &&
        titles.every(t => validTypes.some(type => t.startsWith(type)) || validIds.includes(t));
    })();

    // Early exit: nothing in this container matches the rules
    const contentMatch = validTypes.some(t => content.includes(t));
    if (blockedEls.length === 0 && !isForbiddenSkuSelected && !contentMatch && !allVariantTitlesBlocked) return;

    // Shared helper: hide a variant element AND its visible label/wrapper.
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

    // Sweep: hide any label/button/swatch whose visible text starts with a blocked type.
    // This catches styled variant pickers (label buttons, swatch divs, custom buttons)
    // that don't use standard radio inputs.
    const sweepBlockedLabels = () => {
      container.querySelectorAll(
        "label, option, .swatch-element, " +
        "[class*='option__label'], [class*='variant-label'], [class*='swatch-label'], " +
        "[class*='option-value'], [data-option-value], [data-value]"
      ).forEach(el => {
        if (el.style.display === "none") return;
        const val = elText(el);
        if (validTypes.some(t => val.startsWith(t)) || validIds.some(id => val.startsWith(id))) {
          el.style.setProperty("display", "none", "important");
          const wrap = el.closest(".swatch-element, .variant-input, li, .option__item");
          if (wrap && !wrap.classList.contains("grid__item")) {
            wrap.style.setProperty("display", "none", "important");
          }
        }
      });
    };

    if (hasNonBlockedOpt && !isForbiddenSkuSelected) {
      // ── Multi-variant: hide ONLY the blocked options ─────────────────────
      blockedEls.forEach(hideVariantEl);
      sweepBlockedLabels();

    } else {
      // ── All options blocked (or forbidden SKU selected): disable product ──

      // A0. Hide the blocked variant elements and their labels/buttons.
      //     (Same as the multi-variant branch but here ALL are blocked.)
      blockedEls.forEach(hideVariantEl);
      sweepBlockedLabels();

      // A. Buy button — text scan inside container, then fall back to matching
      //    product-form[data-variants] by variant ID for collection cards where
      //    the quick-add form sits outside the container element.
      const _findBtn = (root) =>
        Array.from(root.querySelectorAll('button, [type="submit"], a.btn')).find(b => {
          if (b.name === "add") return true;
          const t = (b.textContent || "").trim().toLowerCase();
          return t.includes("add to cart") || t.includes("add to bag") ||
                 t.includes("buy now") || t === "add";
        }) || root.querySelector('form[action*="/cart/add"] button');

      let btn = _findBtn(container);
      let pfRoot = null; // extra root found via product-form JSON match

      if (!btn && allVariantTitlesBlocked) {
        // Collect numeric variant IDs from [data-variant-title] hidden inputs
        const variantIds = Array.from(container.querySelectorAll("[data-variant-title]"))
          .map(el => String(el.value || "")).filter(v => /^\d{8,}$/.test(v));
        if (variantIds.length > 0) {
          document.querySelectorAll("product-form[data-variants]").forEach(pf => {
            if (btn) return;
            try {
              const pfIds = JSON.parse(pf.dataset.variants || "[]").map(v => String(v.id));
              if (pfIds.length > 0 && pfIds.every(id => variantIds.includes(id))) {
                pfRoot = pf.closest("li, .card-wrapper, article") || pf.parentElement;
                btn = pf.querySelector('button[name="add"]') ||
                      pf.querySelector('button[type="submit"]');
              }
            } catch (_) {}
          });
        }
      }

      if (btn) {
        btn.disabled    = true;
        btn.textContent = "Back soon";
        btn.style.opacity = "0.5";
        btn.style.setProperty("pointer-events", "none", "important");
      }

      // A1. Hide Pack Size label / variant option heading (product page).
      container.querySelectorAll(
        'legend, .variant__label, [class*="option-name"], [class*="option__name"], ' +
        '[class*="variant-label"], [class*="variant__heading"], ' +
        'fieldset[data-option-name], .product-form__input label'
      ).forEach(el => {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t.includes("pack size") || t.includes("pack type") || t.includes("size")) {
          el.style.setProperty("display", "none", "important");
        }
      });

      // A1b. Hide SKU line (product page).
      container.querySelectorAll(
        '.product__sku, [class*="sku"], [id*="sku"], [class*="product-sku"]'
      ).forEach(el => el.style.setProperty("display", "none", "important"));

      // A2. Quantity selector — hide in container AND in pfRoot (collection quick-add).
      const _hideQty = (root) => root.querySelectorAll(
        '.quantity, .qty, .quantity-selector, ' +
        '[class*="quantity"]:not([class*="price"]), ' +
        'input[name="quantity"], [id*="quantity"]'
      ).forEach(el => el.style.setProperty("display", "none", "important"));
      _hideQty(container);
      if (pfRoot) _hideQty(pfRoot);

      // B. "Back soon" badge (replaces any sale/promo badge).
      const badges = container.querySelectorAll(
        ".badge, .card__badge, .product-badge, .sale-badge, .grid-product__badge"
      );
      let badgeParent = null, templateBadge = null;
      badges.forEach(b => {
        if (!b.querySelector(".badge, .card__badge, .product-badge")) {
          badgeParent   = b.parentElement;
          templateBadge = b;
        }
      });
      if (badgeParent && templateBadge &&
          !badgeParent.textContent.toLowerCase().includes("back soon")) {
        const backSoonBadge = templateBadge.cloneNode(true);
        backSoonBadge.textContent = "Back soon";
        backSoonBadge.className   = templateBadge.className
          .replace(/sale/g,  "back-soon")
          .replace(/Sale/g, "BackSoon");
        backSoonBadge.style.setProperty("background-color", "#4a4a4a", "important");
        backSoonBadge.style.setProperty("color",            "#ffffff", "important");
        backSoonBadge.style.setProperty("border-color",    "#4a4a4a", "important");
        badgeParent.appendChild(backSoonBadge);
      }

      // C. Hide stock / inventory labels — search container AND pfRoot.
      const validTypesLower = validTypes.map(t => t.toLowerCase());
      const _hideStock = (root) => root.querySelectorAll(
        '.inventory, .stock, .variant-wrapper, [id^="Inventory"], ' +
        '[class*="stock"], [class*="inventory"]'
      ).forEach(item => {
        const itemText = (item.textContent || "").toLowerCase();
        const classStr = typeof item.className === "string" ? item.className.toLowerCase() : "";
        if (
          validTypesLower.some(t => itemText.includes(t)) ||
          itemText.includes("in stock") ||
          itemText.includes("stock") ||
          classStr.includes("stock") ||
          classStr.includes("inventory")
        ) {
          item.style.setProperty("display", "none", "important");
        }
      });
      _hideStock(container);
      if (pfRoot) _hideStock(pfRoot);
    }
    // Final step: inject retail strikethroughs
    injectStrikethroughPricing(container);
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────
  async function init() {
    const el =
      document.getElementById("catalog-variant-hider-data") ||
      document.querySelector("[data-location-id]");
    if (!el) return;

    if (!LOCATION_ID && !CUSTOMER_ID) {
      console.warn("[CVH] No locationId or customerId — cannot resolve catalog");
      return;
    }

    console.log("[CVH] Running | locationId:", LOCATION_ID, "| customerId:", CUSTOMER_ID, "| shop:", SHOP);

    const singleProductId = el.dataset.productId || null;

    let resolvedLocationId = LOCATION_ID;

    // Last-resort JS check: /cart.js sometimes carries the company location
    if (!resolvedLocationId) {
      try {
        const cartData = await (await fetch("/cart.js")).json();
        resolvedLocationId =
          cartData?.company_location?.id ||
          cartData?.buyer_identity?.company_location?.id ||
          null;
        if (resolvedLocationId) console.log("[CVH] Got locationId from cart.js:", resolvedLocationId);
      } catch (_) {}
    }

    if (!resolvedLocationId && !CUSTOMER_ID) {
      console.warn("[CVH] No location or customer ID from any source — cannot resolve catalog");
      return;
    }

    if (singleProductId) {
      // ══ PRODUCT PAGE ═════════════════════════════════════════════════════
      console.log(`[CVH] Fetching rules for Product: ${singleProductId} | Location: ${resolvedLocationId}`);
      const rules = await fetchRules(resolvedLocationId, singleProductId);
      console.log("[CVH] RAW API Response:", JSON.stringify(rules, null, 2));
      
      if (rules.debug) {
          console.log(`[CVH] Server Debug | Version: ${rules.debug.version} | Resolved Catalog: ${rules.debug.resolvedCatalogId} | Strategy: ${rules.debug.strategy} | Rule Found: ${rules.debug.ruleFound} (${rules.debug.ruleName || 'None'})`);
      }

      const validTypes = rules.hiddenVariantTypes || [];
      const validIds   = rules.hiddenVariantIds   || [];
      console.log(`[CVH] Final Rules to Apply | Types: ${validTypes.join(", ") || "None"} | IDs: ${validIds.length}`);

      if (validTypes.length === 0 && validIds.length === 0) {
          console.log("[CVH] No rules found for this catalog/product combination.");
          return;
      }

      const SELECTORS =
        "#main-product, article[data-product-url], " +
        ".product, .product-single, .card, .grid__item, .product-section, " +
        ".product-item, .product__info-container";

      let busy = false;
      const applyAll = () => {
        if (busy) return;
        busy = true;
        document.querySelectorAll(SELECTORS).forEach(c => applyRulesToContainer(c, rules));
        setTimeout(() => { busy = false; }, 100);
      };

      applyAll();
      console.log("[CVH] Observer starting on product page");
      new MutationObserver(mutations => {
        if (mutations.some(m => !m.target.closest || !m.target.closest("[data-cvh-processed]"))) {
           // console.log("[CVH] DOM Mutation detected, re-applying rules");
           applyAll();
        }
      }).observe(document.body, { childList: true, subtree: true });

    } else {
      // ══ COLLECTION PAGE ══════════════════════════════════════════════════════
      //
      // processIdElements: find cards not yet seen, mark them immediately
      // (data-cvh-seen) to prevent re-processing, then fetch+apply rules.
      const processIdElements = async (idElements) => {
        const toProcess = [];
        idElements.forEach(pidEl => {
          const pid = pidEl.dataset.productId;
          if (!pid) return;
          const card = pidEl.classList.contains("product-card")
            ? pidEl
            : (pidEl.closest(
                ".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, [class*='product-card']"
              ) || pidEl.closest("li, article") || pidEl);
          if (card.hasAttribute("data-cvh-seen") || card.hasAttribute("data-cvh-processed")) return;
          card.setAttribute("data-cvh-seen", "1");
          toProcess.push([pid, card]);
        });
        if (toProcess.length === 0) return;
        await Promise.all(
          toProcess.map(async ([numericPid, container]) => {
            let pid = numericPid;
            if (pid && !pid.includes("/")) pid = `gid://shopify/Product/${pid}`;
            const rules = await fetchRules(resolvedLocationId, pid);
            applyRulesToContainer(container, rules);
          })
        );
      };

      const initialElements = Array.from(document.querySelectorAll("[data-product-id]"));
      if (initialElements.length > 0) {
        // Phase 1 — blanket rules: one fast API call → hide wrong variants on all cards NOW.
        const blanketRules = await fetchRules(resolvedLocationId, "");
        if ((blanketRules.hiddenVariantTypes || []).length > 0 || (blanketRules.hiddenVariantIds || []).length > 0) {
          document.querySelectorAll("[data-product-id]").forEach(pidEl => {
            const card = pidEl.classList.contains("product-card") ? pidEl
              : (pidEl.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, [class*='product-card']")
                 || pidEl.closest("li, article") || pidEl);
            applyRulesToContainer(card, blanketRules);
          });
        }
        // Phase 2 — per-product overrides: refine any cards that have exceptions.
        await processIdElements(initialElements);
      } else {
        // Fallback: no [data-product-id] on this theme — use collection-level rules.
        const rules = await fetchRules(resolvedLocationId, "");
        if ((rules.hiddenVariantTypes || []).length > 0) {
          document
            .querySelectorAll(
              ".product-card, .product, .product-single, .card, .grid__item, " +
              ".product-section, .product-item, .product__info-container"
            )
            .forEach(c => applyRulesToContainer(c, rules));
        }
      }

      // ── Infinite-scroll watcher ───────────────────────────────────────────
      // When infinite scroll appends new cards the MutationObserver fires.
      // A short debounce coalesces the burst of DOM mutations from one batch
      // into a single processIdElements call. Already-seen cards are skipped,
      // so only newly added products (e.g. 51-100) get fetched and hidden.
      let scrollDebounce = null;
      new MutationObserver(() => {
        clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(() => {
          processIdElements(Array.from(document.querySelectorAll("[data-product-id]")));
        }, 80);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  init();
})();
