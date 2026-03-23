(function () {
  console.log("🚀 [CatalogVariantHider] Script started...");

  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

  function getCatalogData() {
    // Look for our specific ID first, then fallback to the attribute selector
    const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
    
    if (!el) {
      console.warn("⚠️ [CatalogVariantHider] No catalog data element found on this page.");
      return null;
    }

    console.log("📦 [CatalogVariantHider] Data found:", el.dataset);
    return {
      catalogId: el.dataset.catalogId,
      productId: el.dataset.productId || null,
    };
  }

  async function fetchRules(catalogId, productId) {
    console.log(`📡 [CatalogVariantHider] Pinging API for Catalog: ${catalogId}`);
    try {
      const params = new URLSearchParams({ catalogId });
      if (productId) params.append("productId", productId);
      
      const res = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
      
      const data = await res.json();
      console.log("✅ [CatalogVariantHider] Rules received:", data);
      return data;
    } catch (e) {
      console.error("❌ [CatalogVariantHider] Fetch failed:", e);
      return null;
    }
  }

  // ... (Keep your existing getProductVariants, buildHiddenVariantIds, and hide functions here) ...
  // Note: I'm omitting them for brevity, but make sure they stay in your file below fetchRules!

  async function init() {
    const data = getCatalogData();
    if (!data) return;

    const rules = await fetchRules(data.catalogId, data.productId);
    if (!rules) return;

    // Check if we are on a product page
    const isProductPage = !!document.querySelector("variant-selects, .product-form, [data-section-type='product']");
    console.log("🏠 [CatalogVariantHider] Is Product Page:", isProductPage);

    if (isProductPage) {
      const allVariants = getProductVariants();
      console.log(`🔢 [CatalogVariantHider] Found ${allVariants.length} variants on page.`);
      const hiddenIds = buildHiddenVariantIds(rules, allVariants);
      console.log(`🚫 [CatalogVariantHider] Hiding ${hiddenIds.size} variants.`);
      hideOnProductPage(hiddenIds);
    } else {
      console.log("📂 [CatalogVariantHider] Running collection page logic.");
      await hideOnCollectionPage(data.catalogId, rules);
    }
  }

  // Execute
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();