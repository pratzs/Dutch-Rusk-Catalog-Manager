(function () {
  const LOG  = (...a) => console.log("[CVH]", ...a);
  const WARN = (...a) => console.warn("[CVH]", ...a);

  const _el = document.getElementById("catalog-variant-hider-data");
  LOG("▶ Script loaded. Data element:", _el);

  const APP_URL     = (_el && _el.dataset.appUrl) || "https://dutch-rusk-catalog-manager.onrender.com";
  const LOCATION_ID = (_el && _el.dataset.locationId) ? decodeURIComponent(_el.dataset.locationId) : null;
  const CUSTOMER_ID = (_el && _el.dataset.customerId) || null;
  const SHOP        = (_el && _el.dataset.shop) || window.Shopify?.shop || null;

  LOG("Identity →", { LOCATION_ID, CUSTOMER_ID, SHOP, APP_URL });

  const rulesCache = {};
  const SS_PRE    = "cvh4:" + (CUSTOMER_ID || LOCATION_ID || "") + ":";
  const SS_TTL_MS = 60 * 1000; // 60-second TTL — keeps storefront fresh after admin rule changes

  try {
    const prev = sessionStorage.getItem("cvh4:who");
    if (prev !== (CUSTOMER_ID || LOCATION_ID || "")) {
      const cleared = Object.keys(sessionStorage).filter(k => k.startsWith("cvh4:"));
      cleared.forEach(k => sessionStorage.removeItem(k));
      LOG("Session storage cleared (identity changed). Removed keys:", cleared);
    }
    sessionStorage.setItem("cvh4:who", CUSTOMER_ID || LOCATION_ID || "");
  } catch (_) { /* sessionStorage unavailable (private mode/quota) */ }

  // ── Loading-mask CSS fallback ─────────────────────────────────────────────
  // catalog-hider.liquid injects the primary CSS (using :not([data-cvh-processed])
  // selectors) server-side for B2B collection pages. This fallback fires only
  // when that liquid CSS is absent (e.g. dev preview, theme not yet re-saved).
  (function injectLoadingMaskFallback() {
    if (document.getElementById("cvh-b2b-mask") || document.getElementById("cvh-b2b-mask-pdp") || document.getElementById("cvh-loading-mask")) return;
    const CARDS = ":is(.product-card,.card-wrapper,.product-card-wrapper,li.grid__item,article)";
    const INNER = [
      'input[type="radio"]',
      'input[type="radio"] + label',
      "label[for]",
      "label",
      "variant-selects",
      "fieldset",
      ".swatch-element",
      ".variant-input",
      ".product-form__input",
      "button[data-variant-id]",
      'select[name="id"]',
    ];
    // Layer 1a: CSS :not([data-cvh-processed]) for initial load
    const cssHide = INNER.map(sel => `${CARDS}:not([data-cvh-processed]) ${sel}`).join(",") +
      `{opacity:0!important;pointer-events:none!important;user-select:none!important;transition:none!important;}`;
    // Layer 1b: [data-cvh-loading] for infinite-scroll cards (JS-stamped)
    const jsHide = INNER.map(sel => `[data-cvh-loading] ${sel}`).join(",") +
      `{opacity:0!important;pointer-events:none!important;user-select:none!important;transition:none!important;}`;
    // Restore rule must use the same :is() selector to match specificity (0,2,2)
    // of the hiding rules — a bare [data-cvh-processed] is only (0,1,1) and loses.
    // Exclude input[type="radio"] and its sibling label: the theme manages radio
    // input visibility itself; restoring opacity:1 on it shows the native browser dot.
    const INNER_RESTORE = INNER.filter(s => s !== 'input[type="radio"]' && s !== 'input[type="radio"] + label');
    const showRules = INNER_RESTORE.map(sel => `${CARDS}[data-cvh-processed] ${sel}`).join(",") +
      `{opacity:1!important;pointer-events:auto!important;user-select:auto!important;}`;
    const s = document.createElement("style");
    s.id = "cvh-loading-mask";
    s.textContent = cssHide + jsHide + showRules;
    document.head.appendChild(s);
  })();

  // ── Card variant availability ──────────────────────────────────────────────
  // There is no bulk cross-product "/variants.json?ids=" Storefront AJAX
  // endpoint — that route always 404s, so a variant-ID → availability cache
  // fetched that way is permanently empty and silently no-ops. Availability
  // is instead read straight from the theme's own live-updating
  // `.product__inventory` status pill (see readCardAvailability below), which
  // reflects this customer's real per-location stock and needs no network call.

  // ── Single-product rule fetch (used on product pages) ────────────────────
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
        if (Array.isArray(d.hiddenVariantTypes) && (!d._cvh_exp || Date.now() < d._cvh_exp)) {
          rulesCache[cacheKey] = d;
          LOG(`fetchRules [SS-CACHE HIT] key="${ssKey}"`, d);
          return d;
        }
        sessionStorage.removeItem(ssKey);
        LOG(`fetchRules [SS-CACHE EXPIRED] key="${ssKey}" — re-fetching`);
      }
    } catch (_) { /* sessionStorage unavailable (private mode/quota) */ }

    try {
      const params = new URLSearchParams();
      if (locationId) params.set("locationId", locationId);
      if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
      if (productId) params.set("productId", productId);
      params.set("_t", Date.now());

      const url = `${APP_URL}/api/catalog-rules?${params}`;
      LOG(`fetchRules [API FETCH] → ${url}`);

      const res = await fetch(url);
      if (!res.ok) {
        WARN(`fetchRules: API returned ${res.status} — failing closed (keeping mask)`);
        return null;
      }
      const data = await res.json();
      LOG(`fetchRules [API RESPONSE] productId="${productId || "(blanket)"}"`, data);

      if (Array.isArray(data.hiddenVariantTypes)) {
        rulesCache[cacheKey] = data;
        try { sessionStorage.setItem(ssKey, JSON.stringify({ ...data, _cvh_exp: Date.now() + SS_TTL_MS })); } catch (_) { /* sessionStorage unavailable (private mode/quota) */ }
      } else {
        WARN("fetchRules: API response missing hiddenVariantTypes array", data);
      }
      return data;
    } catch (err) {
      WARN("fetchRules: fetch failed — failing closed (keeping mask):", err);
      return null;
    }
  }

  // ── Batch rule fetch helpers ──────────────────────────────────────────────

  // doFetchBatchChunked: fires the actual API call(s) for a list of normPids.
  // Results are written into rulesCache, sessionStorage, and optionally into
  // the supplied resultMap (pass null for background-refresh calls).
  async function doFetchBatchChunked(locationId, normPids, resultMap) {
    const CHUNK_SIZE = 50;
    for (let i = 0; i < normPids.length; i += CHUNK_SIZE) {
      const chunk = normPids.slice(i, i + CHUNK_SIZE);
      try {
        const params = new URLSearchParams();
        params.set("productIds", chunk.join(","));
        if (locationId) params.set("locationId", locationId);
        if (CUSTOMER_ID) { params.set("customerId", CUSTOMER_ID); if (SHOP) params.set("shop", SHOP); }
        params.set("_t", Date.now());

        const url = `${APP_URL}/api/catalog-rules?${params}`;
        LOG(`doFetchBatchChunked [API FETCH] ${chunk.length} products →`, url.slice(0, 120) + "...");

        const res = await fetch(url);
        if (!res.ok) {
          WARN(`doFetchBatchChunked: API returned ${res.status} — failing closed for chunk [${i}..${i + chunk.length - 1}]`);
          for (const pid of chunk) {
            const cacheKey = `${locationId || CUSTOMER_ID}::${pid}`;
            rulesCache[cacheKey] = { _cvh_error: true };
            if (resultMap) resultMap[pid] = { _cvh_error: true };
          }
          continue;
        }
        const data = await res.json();
        LOG(`doFetchBatchChunked [API RESPONSE] returned ${Object.keys(data.batch ?? {}).length} rules`);

        if (data.batch) {
          for (const [pid, rules] of Object.entries(data.batch)) {
            if (Array.isArray(rules.hiddenVariantTypes)) {
              const cacheKey = `${locationId || CUSTOMER_ID}::${pid}`;
              rulesCache[cacheKey] = rules;
              if (resultMap) resultMap[pid] = rules;
              try {
                sessionStorage.setItem(SS_PRE + pid, JSON.stringify({ ...rules, _cvh_exp: Date.now() + SS_TTL_MS }));
              } catch (_) { /* sessionStorage unavailable (private mode/quota) */ }
            }
          }
        }
      } catch (err) {
        WARN(`doFetchBatchChunked: fetch failed for chunk [${i}..${i + chunk.length - 1}] — failing closed:`, err);
        for (const pid of chunk) {
          const cacheKey = `${locationId || CUSTOMER_ID}::${pid}`;
          rulesCache[cacheKey] = { _cvh_error: true };
          if (resultMap) resultMap[pid] = { _cvh_error: true };
        }
      }
    }
  }

  // ── Batch rule fetch (collection page — ONE API call for many products) ───
  //
  // Uses a stale-while-revalidate strategy:
  //   • Memory cache hit   → returned instantly (no network)
  //   • sessionStorage hit (fresh, within TTL) → returned instantly
  //   • sessionStorage hit (STALE, TTL expired) → returned IMMEDIATELY using
  //     the old value, and a background refresh is fired so the next page load
  //     gets fresh data. This eliminates the "cold Render" wait for repeat
  //     visitors because stale rules are almost always still correct.
  //   • Cache miss → blocking API call (only on truly first load)
  //
  // Returns a map of { normProductId → rules }.
  async function fetchRulesBatch(locationId, productIds) {
    if (!productIds?.length) return {};

    const result    = {};
    const toFetch   = [];   // Needs a blocking API call
    const toRefresh = [];   // Has stale cache — serve immediately, refresh in bg

    for (const productId of productIds) {
      const normPid  = String(productId).includes("/") ? productId.split("/").pop() : String(productId);
      const cacheKey = `${locationId || CUSTOMER_ID}::${normPid}`;

      // ① Memory cache (always fresh within this page load)
      if (rulesCache[cacheKey]) {
        result[normPid] = rulesCache[cacheKey];
        continue;
      }

      // ② sessionStorage (may be fresh OR stale)
      const ssKey = SS_PRE + normPid;
      try {
        const s = sessionStorage.getItem(ssKey);
        if (s) {
          const d = JSON.parse(s);
          if (Array.isArray(d.hiddenVariantTypes)) {
            // Always serve what we have — instantly unblocks card processing
            rulesCache[cacheKey] = d;
            result[normPid] = d;
            if (d._cvh_exp && Date.now() > d._cvh_exp) {
              // Stale: schedule a background refresh for next visit
              toRefresh.push(normPid);
              LOG(`fetchRulesBatch [SS-STALE] pid="${normPid}" — serving stale, scheduling bg refresh`);
            }
            continue;
          }
          sessionStorage.removeItem(ssKey);
        }
      } catch (_) { /* sessionStorage unavailable (private mode/quota) */ }

      toFetch.push(normPid);
    }

    // ③ Background refresh for stale entries (non-blocking — fire and forget)
    if (toRefresh.length > 0) {
      LOG(`fetchRulesBatch: refreshing ${toRefresh.length} stale products in background`);
      doFetchBatchChunked(locationId, toRefresh, null).catch(() => {});
    }

    // ④ Blocking fetch for true cache misses
    if (toFetch.length === 0) {
      LOG(`fetchRulesBatch: all ${productIds.length} products served from cache (${toRefresh.length} stale/refreshing)`);
      return result;
    }

    LOG(`fetchRulesBatch: ${toFetch.length} cache-miss products need blocking API fetch`);
    await doFetchBatchChunked(locationId, toFetch, result);

    return result;
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

  // ── "Back Soon" state ─────────────────────────────────────────────────────
  function applyBackSoonState(scope) {
    if (scope.dataset?.cvhBackSoon) return;
    if (scope.dataset) scope.dataset.cvhBackSoon = "1";
    LOG(`  → applyBackSoonState on <${scope.tagName}>`);

    scope.querySelectorAll("variant-selects").forEach(el =>
      el.style.setProperty("display", "none", "important")
    );

    scope.querySelectorAll('input[type="radio"]').forEach(radio => {
      let el = radio.parentElement;
      let depth = 0;
      while (el && el !== scope && depth < 8) {
        if (
          el.tagName === "FIELDSET" ||
          el.tagName === "VARIANT-SELECTS" ||
          el.classList.contains("product-form__input") ||
          el.classList.contains("product-variants") ||
          el.classList.contains("variant-wrapper")
        ) {
          el.style.setProperty("display", "none", "important");
          break;
        }
        el = el.parentElement;
        depth++;
      }
    });

    scope.querySelectorAll(
      'quantity-input, .quantity, [class*="quantity__"], .product-form__quantity'
    ).forEach(el => el.style.setProperty("display", "none", "important"));

    scope.querySelectorAll('.cvh-strikethrough').forEach(el =>
      el.style.setProperty("display", "none", "important")
    );

    scope.querySelectorAll(
      '.price, .price-item, .price-item--regular, .product__price, .grid-product__price, .price__container, [data-price], .current-price'
    ).forEach(el => {
      el.style.setProperty("opacity", "0.45", "important");
      el.style.setProperty("text-decoration", "line-through", "important");
    });

    const addBtn = scope.querySelector('button[name="add"], button[data-add-to-cart]');
    if (addBtn && !addBtn.dataset.cvhBackSoon) {
      addBtn.dataset.cvhBackSoon = "1";
      addBtn.disabled = true;
      addBtn.style.opacity = "0.7";
      addBtn.style.cursor = "not-allowed";
      addBtn.innerHTML = "Back Soon";
      LOG(`  → "Back Soon" button applied`);
    } else if (!addBtn) {
      LOG(`  → applyBackSoonState: no add-to-cart button found in scope`);
    }
  }

  // Reads the theme's own live-updating inventory-status pill for a card.
  // Returns true/false, or undefined if the card has no such pill (theme
  // doesn't render one — caller should leave the add-to-cart button alone).
  function readCardAvailability(card) {
    const pill = card.querySelector(".product__inventory");
    if (!pill) return undefined;
    return !pill.className.split(/\s+/).includes("product-inventory--out");
  }

  function setupCardAvailabilityWatcher(card) {
    if (card.dataset.cvhAvailWatch) return;
    card.dataset.cvhAvailWatch = "1";

    const radios = card.querySelectorAll('input[type="radio"]');
    if (!radios.length) return;

    const updatePurchaseState = () => {
      const available = readCardAvailability(card);
      if (available === undefined) return;

      const addBtn = card.querySelector('button[name="add"], button[data-add-to-cart]');
      const qtyEl = card.querySelector('quantity-input, .quantity, [class*="quantity__"], .product-form__quantity');

      if (!available) {
        if (addBtn && !addBtn.dataset.cvhUnavail) {
          addBtn.dataset.cvhUnavail = "1";
          addBtn._cvhOrigHTML = addBtn._cvhOrigHTML || addBtn.innerHTML;
          addBtn._cvhOrigDisabled = addBtn._cvhOrigDisabled ?? addBtn.disabled;
          addBtn.disabled = true;
          addBtn.style.opacity = "0.7";
          addBtn.style.cursor = "not-allowed";
          addBtn.innerHTML = "Back Soon";
        }
        if (qtyEl) qtyEl.style.setProperty("display", "none", "important");
      } else {
        if (addBtn && addBtn.dataset.cvhUnavail) {
          delete addBtn.dataset.cvhUnavail;
          addBtn.innerHTML = addBtn._cvhOrigHTML || "Add to Cart";
          addBtn.disabled = addBtn._cvhOrigDisabled || false;
          addBtn.style.opacity = "";
          addBtn.style.cursor = "";
        }
        if (qtyEl) qtyEl.style.removeProperty("display");
      }
    };

    // The theme updates the status pill's class/text asynchronously after the
    // variant 'change' event (not synchronously within the same dispatch), so
    // reading it directly inside a 'change' listener can catch a stale value.
    // Watching the pill itself for its own mutation is race-free regardless
    // of when or how the theme decides to update it.
    const pill = card.querySelector(".product__inventory");
    if (pill) {
      new MutationObserver(updatePurchaseState).observe(pill, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        characterData: true,
        subtree: true,
      });
    } else {
      radios.forEach(r => r.addEventListener("change", updatePurchaseState));
    }
    updatePurchaseState();
  }

  function applyRulesToContainer(container, rules, label) {
    const validTypes = rules.hiddenVariantTypes || [];
    const validIds   = rules.hiddenVariantIds   || [];
    const tag = label || container.tagName + (container.id ? `#${container.id}` : "") + (container.className ? `.${String(container.className).split(" ")[0]}` : "");

    LOG(`applyRules [${tag}] rules →`, { hiddenVariantTypes: validTypes, hiddenVariantIds: validIds });

    // Always mark as processed — the server-side CSS mask uses this to restore
    // opacity on the card, so it must be set even when there are no rules to hide.
    container.setAttribute("data-cvh-processed", "1");

    if (validTypes.length === 0 && validIds.length === 0) {
      LOG(`applyRules [${tag}] → NO rules, skipping hide (injecting strikethrough only)`);
      injectStrikethroughPricing(container);
      return;
    }

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

      if (!rules) {
        WARN("Product page: API error — applying Back Soon (fail-closed)");
        const mainEl = document.querySelector('#MainContent, main, [role="main"]') || document.body;
        applyBackSoonState(mainEl);
        document.querySelectorAll("product-form, .product__info-container").forEach(c =>
          c.setAttribute("data-cvh-processed", "1")
        );
        return;
      }

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

        const pageRadios = Array.from(document.querySelectorAll('variant-selects input[type="radio"]'));
        if (pageRadios.length > 0 && pageRadios.every(r => r.style.display === "none")) {
          const mainEl = document.querySelector('#MainContent, main, [role="main"]') || document.body;
          applyBackSoonState(mainEl);
        }
      };

      applyAll();
      new MutationObserver(applyAll).observe(document.body, { childList: true, subtree: true });

    } else {
      // ── COLLECTION PAGE ───────────────────────────────────────────────────
      // Key design: cards are IMMEDIATELY masked (opacity:0, pointer-events:none)
      // the moment they are discovered. One batch API call then fetches rules for
      // ALL new cards at once (vs one call per product). Cards are unmasked only
      // after rules have been applied, so customers never see or click a variant
      // that should be hidden.
      const processBatch = async () => {
        const pidElements = Array.from(document.querySelectorAll("[data-product-id]:not([data-cvh-seen])"));
        LOG(`Collection processBatch: found ${pidElements.length} unseen [data-product-id] elements`);
        if (pidElements.length === 0) return;

        // Mark seen immediately so concurrent MutationObserver firings don't
        // double-process the same cards.
        pidElements.forEach(el => el.setAttribute("data-cvh-seen", "1"));

        // ── Step 1: Mask cards immediately + collect card metadata ───────────
        // CSS :not([data-cvh-processed]) covers the initial page load.
        // [data-cvh-loading] covers infinite-scroll cards: new nodes injected by
        // JS can be painted by the browser before the CSS engine recalculates
        // :not() — setting the attribute synchronously here (before any await)
        // closes that gap via the [data-cvh-loading] CSS rule.
        const cardMeta = pidElements.map(el => {
          const productId = el.dataset.productId;
          const card = el.closest(".product-card, .card-wrapper, .product-card-wrapper, li.grid__item, article") || el;

          card.setAttribute("data-cvh-loading", "1");

          LOG(`  Collection card: productId="${productId}" container=<${card.tagName} class="${String(card.className).slice(0,50)}">`);
          return { productId, card };
        });

        // ── Step 2: Fetch catalog rules (app) ─────────────────────────────────
        const batchRules = await fetchRulesBatch(resolvedLocationId, cardMeta.map(m => m.productId));

        // ── Step 3: Apply rules + unmask each card ───────────────────────────
        cardMeta.forEach(({ productId, card }) => {
          try {
            const normPid = String(productId).includes("/") ? productId.split("/").pop() : productId;
            const rules = batchRules[normPid] || { hiddenVariantTypes: [], hiddenVariantIds: [], hasOverride: false };

            if (rules._cvh_error) {
              WARN(`  Card ${productId}: API error — applying Back Soon (fail-closed)`);
              applyBackSoonState(card);
              card.setAttribute("data-cvh-processed", "1");
              card.removeAttribute("data-cvh-loading");
              return;
            }

            applyRulesToContainer(card, rules, `card:${productId}`);
            setupCardAvailabilityWatcher(card);

            const cardRadios = Array.from(card.querySelectorAll('input[type="radio"]'));
            if (cardRadios.length > 0 && cardRadios.every(r => r.style.display === "none")) {
              applyBackSoonState(card);
            }

            card.setAttribute("data-cvh-processed", "1");
            card.removeAttribute("data-cvh-loading");
          } catch (err) {
            WARN(`  processBatch error for productId=${productId} — applying Back Soon (fail-closed):`, err);
            applyBackSoonState(card);
            card.setAttribute("data-cvh-processed", "1");
            card.removeAttribute("data-cvh-loading");
          }
        });
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
