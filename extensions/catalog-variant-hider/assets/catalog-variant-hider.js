(function () {
  console.log("🚀 [CatalogVariantHider] Script started...");
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

  function getCatalogData() {
    const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
    if (!el) {
      console.warn("⚠️ [CatalogVariantHider] No catalog data element found.");
      return null;
    }
    return {
      catalogId: el.dataset.catalogId,
      productId: el.dataset.productId || null,
    };
  }

  async function fetchRules(catalogId, productId) {
    console.log(`📡 [CatalogVariantHider] Pinging API...`);
    try {
      const params = new URLSearchParams({ catalogId });
      if (productId) params.append("productId", productId);
      const res = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      const data = await res.json();
      console.log("✅ [CatalogVariantHider] Rules received:", data);
      return data;
    } catch (e) {
      console.error("❌ [CatalogVariantHider] Fetch failed:", e);
      return null;
    }
  }

  function getProductVariants() {
    if (window.ShopifyAnalytics?.meta?.product) {
      return window.ShopifyAnalytics.meta.product.variants || [];
    }
    if (window.__st?.variants) return window.__st.variants;
    return [];
  }

  function buildHiddenVariantIds(rules, allVariants) {
    const { hiddenVariantTypes, hiddenVariantIds, hasOverride } = rules;
    const hidden = new Set();
    if (hasOverride && hiddenVariantIds) {
      hiddenVariantIds.forEach(id => hidden.add(String(id).split('/').pop()));
    } else if (hiddenVariantTypes?.length > 0) {
      allVariants.forEach(v => {
        const title = v.title || v.option1 || "";
        if (hiddenVariantTypes.some(type => title.startsWith(type))) {
          hidden.add(String(v.id));
        }
      });
    }
    return hidden;
  }

  function hideOnProductPage(hiddenIds) {
    if (hiddenIds.size === 0) return;
    const apply = () => {
      // Target Ignite theme selectors
      document.querySelectorAll("input[value], [data-variant-id], .variant-picker__option-value, select[name='id'] option").forEach(el => {
        const val = el.value || el.dataset.variantId || el.textContent.trim();
        // Check if the value or the text matches a hidden ID or Title
        if (hiddenIds.has(String(val))) {
          const wrapper = el.closest(".swatch-element, .variant-option, li, label, option") || el;
          wrapper.style.display = "none";
          if (el.tagName === 'OPTION') el.disabled = true;
        }
      });
    };
    apply();
    setTimeout(apply, 500); // Handle Ignite's dynamic loading
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    const data = getCatalogData();
    if (!data) return;
    const rules = await fetchRules(data.catalogId, data.productId);
    if (!rules) return;

    const isProductPage = !!document.querySelector("variant-selects, .product-form, [data-section-type='product']");
    if (isProductPage) {
      const allVariants = getProductVariants();
      const hiddenIds = buildHiddenVariantIds(rules, allVariants);
      console.log(`🚫 [CatalogVariantHider] Hiding ${hiddenIds.size} variants.`);
      hideOnProductPage(hiddenIds);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();