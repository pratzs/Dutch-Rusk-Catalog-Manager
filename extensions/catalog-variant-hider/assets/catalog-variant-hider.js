(function () {
  // Only run for B2B customers
  const customerId = window.__st?.cid;
  const shop = window.Shopify?.shop;

  if (!shop) return;

  // Get catalog ID from customer metafield or page context
  // Shopify B2B exposes company info via liquid which we inject via snippet
  const catalogId = document.querySelector('[data-catalog-id]')?.dataset?.catalogId;
  const productId = document.querySelector('[data-product-id]')?.dataset?.productId;

  if (!catalogId) return;

  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

  async function fetchRules() {
    try {
      const params = new URLSearchParams({ catalogId });
      if (productId) params.append("productId", productId);

      const res = await fetch(`${APP_URL}/api/catalog-rules?${params}`);
      if (!res.ok) return;
      return await res.json();
    } catch (e) {
      console.error("[CatalogVariantHider] Error fetching rules:", e);
    }
  }

  function hideVariants(rules) {
    if (!rules) return;

    const { hiddenVariantTypes, hiddenVariantIds, hasOverride } = rules;

    // Find all variant option selectors and buttons
    const variantSelectors = document.querySelectorAll(
      '[name="id"] option, .variant-selector option, select[name="id"] option'
    );

    // Also target swatch/button style selectors
    const variantButtons = document.querySelectorAll(
      '[data-variant-id], .variant-button, .swatch-element'
    );

    // Get all variants from Shopify's global object
    const productVariants = window.ShopifyAnalytics?.meta?.product?.variants
      || window.__product?.variants
      || [];

    if (hasOverride && hiddenVariantIds && hiddenVariantIds.length > 0) {
      // Use specific variant IDs from override
      hideByVariantIds(hiddenVariantIds, productVariants);
    } else if (hiddenVariantTypes && hiddenVariantTypes.length > 0) {
      // Use bulk rules - hide by variant type prefix
      hideByVariantTypes(hiddenVariantTypes, productVariants);
    }
  }

  function hideByVariantIds(hiddenIds, allVariants) {
    hiddenIds.forEach((variantId) => {
      // Extract numeric ID from GID if needed
      const numericId = variantId.includes("gid://")
        ? variantId.split("/").pop()
        : variantId;

      // Hide select options
      document
        .querySelectorAll(`option[value="${numericId}"]`)
        .forEach((el) => {
          el.style.display = "none";
          el.disabled = true;
        });

      // Hide variant buttons/swatches
      document
        .querySelectorAll(
          `[data-variant-id="${numericId}"], [data-value="${numericId}"]`
        )
        .forEach((el) => {
          el.style.display = "none";
        });
    });
  }

  function hideByVariantTypes(hiddenTypes, allVariants) {
    // Build list of variant IDs that match hidden types
    const variantsToHide = allVariants.filter((v) => {
      const title = v.title || v.option1 || "";
      return hiddenTypes.some((type) => title.startsWith(type));
    });

    const idsToHide = variantsToHide.map((v) => String(v.id));
    hideByVariantIds(idsToHide, []);

    // Also hide by option text content for themes that use text
    document
      .querySelectorAll(
        '[name="id"] option, select[name="id"] option, .variant-selector option'
      )
      .forEach((option) => {
        const text = option.textContent.trim();
        if (hiddenTypes.some((type) => text.startsWith(type))) {
          option.style.display = "none";
          option.disabled = true;
        }
      });

    // Hide collection card variant pills/buttons by text
    document
      .querySelectorAll(
        '.variant-button, .swatch-element label, [data-variant-option], .product-form__option'
      )
      .forEach((el) => {
        const text = el.textContent.trim();
        if (hiddenTypes.some((type) => text.startsWith(type))) {
          el.style.display = "none";
          el.closest("li, .swatch-element, [data-variant-item]")?.style &&
            (el.closest(
              "li, .swatch-element, [data-variant-item]"
            ).style.display = "none");
        }
      });
  }

  // Run on page load
  fetchRules().then(hideVariants);

  // Re-run if variants change dynamically (for SPAs / theme JS)
  const observer = new MutationObserver(() => {
    fetchRules().then(hideVariants);
  });

  const variantContainer = document.querySelector(
    '.product-form, .product__selects, [data-product-form], form[action="/cart/add"]'
  );

  if (variantContainer) {
    observer.observe(variantContainer, { childList: true, subtree: true });
  }
})();