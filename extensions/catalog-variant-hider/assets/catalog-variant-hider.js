(function () {
  const LOG = (...a) => console.log("[CVH]", ...a);
  const WARN = (...a) => console.warn("[CVH]", ...a);

  const _el = document.getElementById("catalog-variant-hider-data");
  LOG("▶ Script loaded. Data element:", _el);

  const APP_URL     = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = (_el && _el.dataset.customerId) || null;
  const SHOP        = (_el && _el.dataset.shop) || window.Shopify?.shop || null;

  LOG("Identity →", { LOCATION_ID, CUSTOMER_ID, SHOP, APP_URL });

  const rulesCache = {};
  const SS_PRE = "cvh3:" + (CUSTOMER_ID || LOCATION_ID || "") + ":";

  try {
    const prev = sessionStorage.getItem("cvh3:who");
    if (prev !== (CUSTOMER_ID || LOCATION_ID || "")) {
      const cleared = Object.keys(sessionStorage).filter(k => k.startsWith("cvh3:"));
      cleared.forEach(k => sessionStorage.removeItem(k));
      LOG("Session storage cleared (identity changed). Removed keys:", cleared);
    }
    sessionStorage.setItem("cvh3:who", CUSTOMER_ID || LOCATION_ID || "");
  } catch (_) {}

  async function fetchRules(locationId, productId) {
    const normPid = productId
      ? (String(productId).includes("/") ? String(productId).split("/").pop() : String(productId))
      : "";
    const cacheKey = `${locationId || CUSTOMER_ID}::${normPid}`;

    if (rulesCache[cacheKey]) {
      LOG(`fetchRules [MEM-CACHE HIT] key="${cacheKey}"`, rulesCache[cacheKey]);
      return rulesCache[cacheKey];
    }

    const ssKey = SS_PRE + (normPid || "__blanket");
    try {
      const s = sessionStorage.getItem(ssKey);
      if (s) {
        const d = JSON.parse(s);
        if (Array.isArray(d.hiddenVariantTypes)) {
          rulesCache[cacheKey] = d;
          LOG(`fetchRules [SS-CACHE HIT] key="${ssKey}"`, d);
          return d;
        }
      }
    } catch (_) {}

    try {
      const params = new URLSearchParams();
      if (locationId) params.set("locationId", locationId);
      if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
      if (productId) params.set("productId", productId);
      params.set("_t", Date.now());

      const url = `${APP_URL}/api/catalog-rules?${params}`;
      LOG(`fetchRules [API FETCH] → ${url}`);

      const res  = await fetch(url);
      const data = await res.json();

      LOG(`fetchRules [API RESPONSE] productId="${productId || "(blanket)"}"`, data);

      if (Array.isArray(data.hiddenVariantTypes)) {
        rulesCache[cacheKey] = data;
        try { sessionStorage.setItem(ssKey, JSON.stringify(data)); } catch (_) {}
      } else {
        WARN("fetchRules: API response missing hiddenVariantTypes array", data);
      }
      return data;
    } catch (err) {
      WARN("fetchRules: fetch failed →", err);
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

  function applyRulesToContainer(container, rules, label) {
    const validTypes = rules.hiddenVariantTypes || [];
    const validIds   = rules.hiddenVariantIds   || [];
    const tag = label || container.tagName + (container.id ? `#${container.id}` : "") + (container.className ? `.${String(container.className).split(" ")[0]}` : "");

    LOG(`applyRules [${tag}] rules →`, { hiddenVariantTypes: validTypes, hiddenVariantIds: validIds });

    if (validTypes.length === 0 && validIds.length === 0) {
      LOG(`applyRules [${tag}] → NO rules, skipping hide (injecting strikethrough only)`);
      injectStrikethroughPricing(container);
      return;
    }

    container.setAttribute("data-cvh-processed", "1");

    const allVariantEls = Array.from(
      container.querySelectorAll('input[type="radio"], option, button[data-variant-id], .variant-input input, label[data-value]')
    );
    LOG(`applyRules [${tag}] variant elements found:`, allVariantEls.length, allVariantEls.map(el => ({
      tag: el.tagName, type: el.type, value: el.value, text: el.textContent?.trim().slice(0, 40)
    })));

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
      LOG(`  → HIDING variant el: tag=${el.tagName} value="${el.value}" text="${el.textContent?.trim().slice(0,40)}"`);
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
      const swept = [];
      container.querySelectorAll(
        "label, option, .swatch-element, [class*='option__label'], [class*='variant-label']," +
        "[class*='swatch-label'], [class*='option-value'], [data-option-value], [data-value]"
      ).forEach(el => {
        if (el.style.display === "none") return;
        if (isBlockedEl(el)) {
          swept.push(el.textContent?.trim().slice(0, 40));
          el.style.setProperty("display", "none", "important");
          const wrap = el.closest(".swatch-element, .variant-input, li, .option__item");
          if (wrap && !wrap.classList.contains("grid__item")) {
            wrap.style.setProperty("display", "none", "important");
          }
        }
      });
      if (swept.length) LOG(`  → sweepBlockedLabels hidden:`, swept);
      else LOG(`  → sweepBlockedLabels: nothing to hide`);
    };

    const blockedEls = allVariantEls.filter(isBlockedEl);
    LOG(`applyRules [${tag}] blocked variant els:`, blockedEls.length, blockedEls.map(el => elText(el)));
    blockedEls.forEach(hideVariantEl);
    sweepBlockedLabels();

    const checkedRadio = container.querySelector('input[type="radio"]:checked');
    if (checkedRadio && isBlockedEl(checkedRadio)) {
      const firstVisible = allVariantEls.find(el => el.type === "radio" && !isBlockedEl(el));
      if (firstVisible) {
        LOG(`  → Auto-selecting first visible radio: "${elText(firstVisible)}"`);
        firstVisible.checked = true;
        firstVisible.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    injectStrikethroughPricing(container);
  }

  async function init() {
    LOG("▶ init() called");

    const el = document.getElementById("catalog-variant-hider-data") || document.querySelector("[data-location-id]");
    if (!el) { WARN("init: data element not found — is the snippet injected and is customer B2B?"); return; }
    if (!LOCATION_ID && !CUSTOMER_ID) { WARN("init: no LOCATION_ID or CUSTOMER_ID — script will not run"); return; }

    const singleProductId = el.dataset.productId || null;
    LOG("Page type:", singleProductId ? `PRODUCT PAGE (id=${singleProductId})` : "COLLECTION / LIST PAGE");

    let resolvedLocationId = LOCATION_ID;
    if (!resolvedLocationId) {
      try {
        const cartData = await (await fetch("/cart.js")).json();
        resolvedLocationId = cartData?.company_location?.id || cartData?.buyer_identity?.company_location?.id || null;
        LOG("LocationId resolved from cart.js →", resolvedLocationId);
      } catch (e) {
        WARN("init: cart.js fetch failed →", e);
      }
    }
    LOG("resolvedLocationId →", resolvedLocationId);

    if (singleProductId) {
      // ── PRODUCT PAGE ──────────────────────────────────────────────────────
      const rules = await fetchRules(resolvedLocationId, singleProductId);
      LOG("Product page rules fetched →", rules);

      const applyAll = () => {
        const seen = new WeakSet();
        let containerCount = 0;

        const specificSelectors = [
          "product-form", "variant-selects", ".product-form",
          ".product__info-container", ".product__info-wrapper",
          "#product-info", ".product-single__meta", ".product-template",
          "#main-product", ".product-single", ".product-section", ".product",
        ].join(", ");

        document.querySelectorAll(specificSelectors).forEach(c => {
          if (seen.has(c)) return;
          seen.add(c);
          containerCount++;
          applyRulesToContainer(c, rules);
        });

        const main = document.querySelector("#MainContent, main, [role='main']") || document.body;
        if (!seen.has(main)) {
          seen.add(main);
          containerCount++;
          applyRulesToContainer(main, rules, "MainContent-fallback");
        }

        LOG(`applyAll: processed ${containerCount} container(s) on product page`);
      };

      applyAll();
      new MutationObserver(applyAll).observe(document.body, { childList: true, subtree: true });

    } else {
      // ── COLLECTION PAGE ───────────────────────────────────────────────────
      const processBatch = async () => {
        const pidElements = Array.from(document.querySelectorAll("[data-product-id]:not([data-cvh-seen])"));
        LOG(`Collection processBatch: found ${pidElements.length} unseen [data-product-id] elements`);
        if (pidElements.length === 0) return;

        pidElements.forEach(el => el.setAttribute("data-cvh-seen", "1"));

        await Promise.all(pidElements.map(async (el) => {
          const productId = el.dataset.productId;
          const card = el.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, article") || el;
          LOG(`  Collection card: productId="${productId}" container=<${card.tagName} class="${String(card.className).slice(0,50)}">`);
          try {
            const rules = await fetchRules(resolvedLocationId, productId);
            applyRulesToContainer(card, rules, `card:${productId}`);
          } catch (err) {
            WARN(`  processBatch error for productId=${productId}:`, err);
          }
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
