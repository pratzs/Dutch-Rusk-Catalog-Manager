// High-priority execution
console.log("🚀 [CatalogVariantHider] Script file reached browser.");

try {
  (function () {
    const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

    async function init() {
      console.log("🔍 [CatalogVariantHider] Running init...");
      
      const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
      
      if (!el) {
        console.warn("⚠️ [CatalogVariantHider] Element not found. Customer might not be B2B.");
        return;
      }

      const { catalogId, productId } = el.dataset;
      console.log(`📡 [CatalogVariantHider] Fetching for Catalog: ${catalogId}`);

      const res = await fetch(`${APP_URL}/api/catalog-rules?catalogId=${catalogId}&productId=${productId || ''}`);
      const rules = await res.json();
      
      console.log("✅ [CatalogVariantHider] Rules:", rules);

      if (rules.hiddenVariantTypes?.length > 0 || rules.hiddenVariantIds?.length > 0) {
        applyHiding(rules);
      }
    }

    function applyHiding(rules) {
      const apply = () => {
        console.log("🚫 [CatalogVariantHider] Hiding elements...");
        // Target Ignite selectors
        document.querySelectorAll("input, label, .variant-picker__option-value, option").forEach(el => {
          const val = el.value || el.textContent.trim();
          const isTypeMatch = rules.hiddenVariantTypes?.some(type => val.startsWith(type));
          const isIdMatch = rules.hiddenVariantIds?.includes(val);

          if (isTypeMatch || isIdMatch) {
            const wrapper = el.closest(".swatch-element, .variant-option, li, label, .variant-input") || el;
            wrapper.style.display = "none";
          }
        });
      };
      apply();
      // Watch for theme changes
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
    }

    // Force run
    if (document.readyState === "complete" || document.readyState === "interactive") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init);
    }
  })();
} catch (e) {
  console.error("❌ [CatalogVariantHider] Critical Script Error:", e);
}