(function () {
  // APP_URL and locationId are injected by the Liquid snippet via data attributes —
  // never hardcoded here so the app can be redeployed without touching this file.
  const _el = document.getElementById("catalog-variant-hider-data");
  const APP_URL = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;

  const rulesCache = {};

  // ── API ──────────────────────────────────────────────────────────────────
  // Sends locationId (company location GID) so the API can resolve the correct catalog.
  // Falls back to catalogId param if locationId is unavailable.
  async function fetchRules(locationId, productId) {
    const key = `${locationId}::${productId || ""}`;
    if (rulesCache[key]) return rulesCache[key];
    try {
      const pid = productId ? encodeURIComponent(productId) : "";
      const locParam = locationId
        ? `locationId=${encodeURIComponent(locationId)}`
        : "";
      const res = await fetch(
        `${APP_URL}/api/catalog-rules?${locParam}&productId=${pid}`
      );
      const data = await res.json();
      rulesCache[key] = data;
      return data;
    } catch (_) {
      return { hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false };
    }
  }

  // ── Apply rules to a single container ───────────────────────────────────
  function applyRulesToContainer(container, rules) {
    // Pack type rules and product override IDs are both applied simultaneously.
    const validTypes = rules.hiddenVariantTypes || [];
    const validIds   = rules.hiddenVariantIds || [];

    if (validTypes.length === 0 && validIds.length === 0) return;

    container.setAttribute("data-cvh-processed", "1");
    const content = container.textContent || "";

    // SKU-based check (product page selected variant)
    const currentSkuEl = container.querySelector(".product__sku, [data-sku]");
    const currentSku   = currentSkuEl ? currentSkuEl.textContent.trim() : "";
    const isForbiddenSkuSelected = validIds.includes(currentSku);

    // Targeted variant-input check (radio buttons / select options only — NOT innerHTML)
    const variantInputMatch = validIds.some(id =>
      Array.from(container.querySelectorAll('input[type="radio"], option'))
        .some(el => el.value === id)
    );

    const isMatch =
      validTypes.some(t => content.includes(t)) ||
      isForbiddenSkuSelected ||
      variantInputMatch;

    if (!isMatch) return;

    // Determine if this container has multiple purchasable options
    const visibleRadios = container.querySelectorAll('input[type="radio"]:not([style*="none"])');
    const hasOtherOptions = visibleRadios.length > 1;

    if (!hasOtherOptions || isForbiddenSkuSelected) {
      // ── Disable the whole product ──────────────────────────────────────

      // A. Buy button
      const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = window.location.pathname.includes("/products/")
          ? "Sold out"
          : "Back soon";
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

    } else {
      // ── Multi-variant: hide only the restricted options ────────────────
      container.querySelectorAll("input, label, option, .swatch-element").forEach(item => {
        const val = item.value || item.textContent || "";
        if (
          validTypes.some(t => val.includes(t)) ||
          validIds.some(id => val.includes(id))
        ) {
          item.style.setProperty("display", "none", "important");
          const wrap = item.closest(".swatch-element, .variant-input, li");
          if (wrap && !wrap.classList.contains("grid__item")) {
            wrap.style.setProperty("display", "none", "important");
          }
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

    // Use the customer's company location GID so the API can resolve the correct catalog.
    const locationId      = LOCATION_ID;
    const singleProductId = el.dataset.productId || null;

    if (!locationId) return; // No B2B location available — nothing to hide.

    if (singleProductId) {
      // ══ PRODUCT PAGE — single product, single fetch ═══════════════════
      const rules = await fetchRules(locationId, singleProductId);
      const validTypes = rules.hiddenVariantTypes || [];
      const validIds   = rules.hiddenVariantIds || [];
      if (validTypes.length === 0 && validIds.length === 0) return;

      const SELECTORS =
        ".product, .product-single, .card, .grid__item, .product-section, " +
        "[data-product-id], .product-item, .product__info-container";

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
      // ══ COLLECTION PAGE — per-product fetching ════════════════════════
      // Walk every [data-product-id] element and resolve its closest product-card
      // ancestor so we always apply rules to the full card, not a nested button.
      const idElements = Array.from(document.querySelectorAll("[data-product-id]"));
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
        // Fetch rules for every product in parallel (results are cached).
        await Promise.all(
          Array.from(containerMap.entries()).map(async ([numericPid, container]) => {
            let pid = numericPid;
            // Themes output numeric IDs; convert to full GID for the API.
            if (pid && !pid.includes("/")) {
              pid = `gid://shopify/Product/${pid}`;
            }
            const rules = await fetchRules(locationId, pid);
            applyRulesToContainer(container, rules);
          })
        );
      } else {
        // Fallback: no product IDs discoverable — apply blanket type rules only.
        // Individual product overrides cannot be applied without a product ID.
        const rules = await fetchRules(locationId, "");
        const validTypes = rules.hiddenVariantTypes || [];
        if (validTypes.length === 0) return;

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
