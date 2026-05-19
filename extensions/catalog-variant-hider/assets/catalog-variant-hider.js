(function () {
  // APP_URL, locationId, customerId, and shop are injected by the Liquid snippet
  // via data attributes — never hardcoded here.
  const _el = document.getElementById("catalog-variant-hider-data");
  const APP_URL     = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = (_el && _el.dataset.customerId) || null;
  const SHOP        = (_el && _el.dataset.shop) || window.Shopify?.shop || null;

  const rulesCache = {};

  // ── API ──────────────────────────────────────────────────────────────────
  async function fetchRules(locationId, productId) {
    const cacheKey = `${locationId || CUSTOMER_ID}::${productId || ""}`;
    if (rulesCache[cacheKey]) return rulesCache[cacheKey];
    try {
      const params = new URLSearchParams();
      if (locationId) {
        params.set("locationId", locationId);
      } else if (CUSTOMER_ID) {
        params.set("customerId", CUSTOMER_ID);
        if (SHOP) params.set("shop", SHOP);
      }
      if (productId) params.set("productId", productId);

      const res  = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      const data = await res.json();
      rulesCache[cacheKey] = data;
      return data;
    } catch (_) {
      return { hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false };
    }
  }

  // ── Apply rules to a single container ───────────────────────────────────
  function applyRulesToContainer(container, rules) {
    const validTypes = rules.hiddenVariantTypes || [];
    const validIds   = rules.hiddenVariantIds   || [];

    if (validTypes.length === 0 && validIds.length === 0) return;

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
      container.querySelectorAll('input[type="radio"], option')
    );

    // For <option> elements el.value is a Shopify numeric variant ID — use textContent.
    // For radio inputs: if value is also a numeric variant ID (collection card pill picker
    // uses value="{{ variant.id }}"), resolve the human-readable label from the wrapping
    // <label> element instead. Otherwise use el.value directly (product page option pickers
    // use value="Outer", value="Shipper", etc.).
    const elText = (el) => {
      if (el.tagName === "OPTION") return (el.textContent || el.value || "").trim();
      const val = (el.value || "").trim();
      if (el.type === "radio" && /^\d{8,}$/.test(val)) {
        const lbl = el.id
          ? container.querySelector(`label[for="${el.id}"]`)
          : el.closest("label");
        const labelText = lbl ? lbl.textContent.trim() : "";
        if (labelText) return labelText;
      }
      return val || (el.textContent || "").trim();
    };

    const isBlockedEl = (el) => {
      const val = elText(el);
      // Use startsWith so that hiding "Outer" never accidentally hides "Shipper (6 Outer)".
      return validTypes.some(t => val.startsWith(t)) || validIds.includes(val);
    };

    const blockedEls = allVariantEls.filter(isBlockedEl);

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
      const rules = await fetchRules(resolvedLocationId, singleProductId);
      console.log("[CVH] Product page rules:", rules);
      const validTypes = rules.hiddenVariantTypes || [];
      const validIds   = rules.hiddenVariantIds   || [];
      if (validTypes.length === 0 && validIds.length === 0) return;

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
      new MutationObserver(mutations => {
        if (mutations.some(m => !m.target.closest || !m.target.closest("[data-cvh-processed]")))
          applyAll();
      }).observe(document.body, { childList: true, subtree: true });

    } else {
      // ══ COLLECTION PAGE ══════════════════════════════════════════════════
      const idElements   = Array.from(document.querySelectorAll("[data-product-id]"));
      const containerMap = new Map();
      idElements.forEach(el => {
        const pid = el.dataset.productId;
        if (!pid) return;
        const card = el.classList.contains("product-card")
          ? el
          : (el.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, [class*='product-card']")
             || el.closest("li, article")
             || el);
        if (!containerMap.has(pid)) containerMap.set(pid, card);
      });

      if (containerMap.size > 0) {
        await Promise.all(
          Array.from(containerMap.entries()).map(async ([numericPid, container]) => {
            let pid = numericPid;
            if (pid && !pid.includes("/")) pid = `gid://shopify/Product/${pid}`;
            const rules = await fetchRules(resolvedLocationId, pid);
            applyRulesToContainer(container, rules);
          })
        );
      } else {
        const rules = await fetchRules(resolvedLocationId, "");
        if ((rules.hiddenVariantTypes || []).length === 0) return;
        document
          .querySelectorAll(
            ".product-card, .product, .product-single, .card, .grid__item, .product-section, .product-item, .product__info-container"
          )
          .forEach(c => applyRulesToContainer(c, rules));
      }
    }
  }

  init();
})();
