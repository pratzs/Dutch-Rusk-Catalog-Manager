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

    // For <option> elements el.value is often a Shopify numeric variant ID, NOT the
    // human-readable option label.  Always prefer textContent for options so we match
    // "Shipper (12 Outer)" instead of "39087234562".
    // For radio inputs el.value IS the option label (e.g. "Outer"), so use it first.
    const elText = (el) =>
      el.tagName === "OPTION"
        ? (el.textContent || el.value || "").trim()
        : (el.value || el.textContent || "").trim();

    const isBlockedEl = (el) => {
      const val = elText(el);
      // Use startsWith so that hiding "Outer" never accidentally hides "Shipper (6 Outer)".
      return validTypes.some(t => val.startsWith(t)) || validIds.includes(val);
    };

    const blockedEls       = allVariantEls.filter(isBlockedEl);
    const hasNonBlockedOpt = allVariantEls.length > 0 &&
                             allVariantEls.some(el => !isBlockedEl(el));

    // Early exit: nothing in this container matches the rules
    const contentMatch = validTypes.some(t => content.includes(t));
    if (blockedEls.length === 0 && !isForbiddenSkuSelected && !contentMatch) return;

    if (hasNonBlockedOpt && !isForbiddenSkuSelected) {
      // ── Multi-variant: hide ONLY the blocked options ─────────────────────

      blockedEls.forEach(el => {
        el.style.setProperty("display", "none", "important");
        // For styled radio pickers the visible button is <label for="id">
        if (el.id) {
          const lbl = container.querySelector(`label[for="${el.id}"]`);
          if (lbl) lbl.style.setProperty("display", "none", "important");
        }
        const wrap = el.closest(".swatch-element, .variant-input, li");
        if (wrap && !wrap.classList.contains("grid__item")) {
          wrap.style.setProperty("display", "none", "important");
        }
      });

      // Catch remaining visible text labels / swatch elements for the blocked types
      container.querySelectorAll("label, option, .swatch-element").forEach(el => {
        if (el.style.display === "none") return;
        const val = elText(el); // uses textContent-first for <option> elements
        if (validTypes.some(t => val.startsWith(t)) || validIds.some(id => val.startsWith(id))) {
          el.style.setProperty("display", "none", "important");
          const wrap = el.closest(".swatch-element, .variant-input, li");
          if (wrap && !wrap.classList.contains("grid__item")) {
            wrap.style.setProperty("display", "none", "important");
          }
        }
      });

    } else {
      // ── All options blocked (or forbidden SKU selected): disable product ──

      // A. Buy button
      const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
      if (btn) {
        btn.disabled     = true;
        btn.textContent  = window.location.pathname.includes("/products/") ? "Sold out" : "Back soon";
        btn.style.opacity = "0.5";
      }

      // B. Sold-out badge (clone nearest existing badge)
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
          !badgeParent.textContent.toLowerCase().includes("sold out")) {
        const soldOutBadge = templateBadge.cloneNode(true);
        soldOutBadge.textContent = "Sold out";
        soldOutBadge.className   = templateBadge.className
          .replace(/sale/g,  "sold-out")
          .replace(/Sale/g, "SoldOut");
        soldOutBadge.style.setProperty("background-color", "#4a4a4a", "important");
        soldOutBadge.style.setProperty("color",            "#ffffff", "important");
        soldOutBadge.style.setProperty("border-color",    "#4a4a4a", "important");
        badgeParent.appendChild(soldOutBadge);
      }

      // C. Hide price / stock / quantity
      const extras = container.querySelectorAll(
        'label, .inventory, .stock, .quantity, .variant-wrapper, [id^="Inventory"], .price, [class*="price"], [class*="stock"], [class*="inventory"]'
      );
      const validTypesLower = validTypes.map(t => t.toLowerCase());
      extras.forEach(item => {
        const itemText = (item.textContent || "").toLowerCase();
        const classStr = typeof item.className === "string" ? item.className.toLowerCase() : "";
        if (
          validTypesLower.some(t => itemText.includes(t)) ||
          itemText.includes("pack size") ||
          itemText.includes("in stock") ||
          itemText.includes("stock") ||
          item.closest(".quantity") ||
          classStr.includes("price") ||
          classStr.includes("stock") ||
          classStr.includes("inventory")
        ) {
          item.style.setProperty("display", "none", "important");
        }
      });
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
          : (el.closest(".product-card") || el);
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
