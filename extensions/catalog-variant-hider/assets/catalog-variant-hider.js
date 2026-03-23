(function () {
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

  // Get catalog ID injected by our Liquid snippet
  function getCatalogData() {
    const el = document.querySelector("[data-catalog-id]");
    if (!el) return null;
    return {
      catalogId: el.dataset.catalogId,
      productId: el.dataset.productId || null,
    };
  }

  // Fetch rules from our app
  async function fetchRules(catalogId, productId) {
    try {
      const params = new URLSearchParams({ catalogId });
      if (productId) params.append("productId", productId);
      const res = await fetch(`${APP_URL}/api/catalog-rules?${params}`, {
        cache: "force-cache",
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Get all variants from Shopify's global product JSON
  function getProductVariants() {
    // Try ShopifyAnalytics first
    if (
      window.ShopifyAnalytics &&
      window.ShopifyAnalytics.meta &&
      window.ShopifyAnalytics.meta.product
    ) {
      return window.ShopifyAnalytics.meta.product.variants || [];
    }
    // Try window.__st
    if (window.__st && window.__st.variants) return window.__st.variants;
    return [];
  }

  // Build set of variant IDs to hide
  function buildHiddenVariantIds(rules, allVariants) {
    if (!rules) return new Set();
    const { hiddenVariantTypes, hiddenVariantIds, hasOverride } = rules;
    const hidden = new Set();

    if (hasOverride && hiddenVariantIds && hiddenVariantIds.length > 0) {
      // Override — use exact variant IDs
      hiddenVariantIds.forEach((id) => {
        // Strip GID prefix if present
        const numericId = String(id).includes("gid://")
          ? id.split("/").pop()
          : String(id);
        hidden.add(numericId);
      });
    } else if (hiddenVariantTypes && hiddenVariantTypes.length > 0) {
      // Bulk rule — match by variant title prefix
      allVariants.forEach((v) => {
        const title = v.title || v.option1 || "";
        const matches = hiddenVariantTypes.some((type) =>
          title.startsWith(type)
        );
        if (matches) hidden.add(String(v.id));
      });
    }

    return hidden;
  }

  // ─── PRODUCT PAGE: Ignite theme uses variant-selects custom element ───────

  function hideOnProductPage(hiddenIds) {
    if (hiddenIds.size === 0) return;

    // Wait for variant-selects to be defined and rendered
    const apply = () => {
      // Ignite renders variants as: input[type="radio"] or input[type="checkbox"]
      // inside .variant-selects or variant-selects element
      // Each input has a value matching the variant id
      const variantSelects = document.querySelectorAll(
        "variant-selects, .variant-selects, [data-section-type='product']"
      );

      // Hide radio/checkbox inputs and their labels
      document
        .querySelectorAll(
          "input[type='radio'][name='id'], input[type='radio'][data-variant-id], input[type='radio'][value]"
        )
        .forEach((input) => {
          const variantId = input.value || input.dataset.variantId;
          if (hiddenIds.has(String(variantId))) {
            const wrapper =
              input.closest(".swatch-element, .variant-option, li, label") ||
              input.parentElement;
            if (wrapper) wrapper.style.display = "none";
          }
        });

      // Hide button-style options (Ignite grid/button picker)
      document
        .querySelectorAll(
          "[data-variant-id], .variant-picker__option-values button, .variant-picker__option-values label"
        )
        .forEach((el) => {
          const variantId =
            el.dataset.variantId || el.dataset.value || el.getAttribute("value");
          if (variantId && hiddenIds.has(String(variantId))) {
            const wrapper = el.closest("li, .variant-option, .swatch-element") || el;
            wrapper.style.display = "none";
          }
        });

      // Ignite specifically uses s-option-list or similar web components
      // Hide by matching option text to variant title
      // We need to get variant titles for the hidden IDs
      const allVariants = getProductVariants();
      const hiddenTitles = new Set(
        allVariants
          .filter((v) => hiddenIds.has(String(v.id)))
          .map((v) => v.title)
      );

      // Option values shown as text buttons/boxes
      document
        .querySelectorAll(
          ".variant-picker__option-value, .variant-option__value, [data-option-value]"
        )
        .forEach((el) => {
          const text = (el.textContent || el.dataset.optionValue || "").trim();
          if (hiddenTitles.has(text)) {
            const wrapper = el.closest("li, .variant-option, label") || el;
            wrapper.style.display = "none";
          }
        });

      // Also disable hidden variants in the native select dropdown (fallback)
      document
        .querySelectorAll("select[name='id'] option, select#Variants option")
        .forEach((option) => {
          if (hiddenIds.has(String(option.value))) {
            option.style.display = "none";
            option.disabled = true;
          }
        });
    };

    // Run immediately and after a short delay for dynamic rendering
    apply();
    setTimeout(apply, 300);
    setTimeout(apply, 800);

    // Also observe DOM changes (Ignite loads variant pickers dynamically)
    const observer = new MutationObserver(apply);
    const productForm = document.querySelector(
      "variant-selects, .product-form, [data-product-form], form[action='/cart/add']"
    );
    if (productForm) {
      observer.observe(productForm, { childList: true, subtree: true });
    }
  }

  // ─── COLLECTION PAGE: Hide variant pills on product cards ─────────────────

  async function hideOnCollectionPage(catalogId, rules) {
    if (!rules) return;
    const { hiddenVariantTypes } = rules;
    if (!hiddenVariantTypes || hiddenVariantTypes.length === 0) return;

    // For each product card, fetch its variants via Shopify's product JSON API
    const productCards = document.querySelectorAll(
      "[data-product-handle], .product-card[data-handle], .card-product[data-handle], article[data-product-handle]"
    );

    if (productCards.length === 0) return;

    // Hide variant option buttons/swatches on collection cards
    // Ignite shows variant options as clickable swatches or color options on cards
    document
      .querySelectorAll(
        ".card-swatch, .variant-swatch, [data-option-value], .product-card__swatch"
      )
      .forEach((el) => {
        const text = (el.title || el.dataset.optionValue || el.textContent || "").trim();
        const matches = hiddenVariantTypes.some((type) => text.startsWith(type));
        if (matches) {
          el.style.display = "none";
        }
      });

    // For quick add modals — also apply product page rules when they open
    document.addEventListener("click", async (e) => {
      const quickAddBtn = e.target.closest(
        "[data-quick-add], .quick-add-button, [data-product-handle]"
      );
      if (!quickAddBtn) return;

      const handle =
        quickAddBtn.dataset.productHandle || quickAddBtn.dataset.handle;
      if (!handle) return;

      // Wait for quick add modal to render
      setTimeout(async () => {
        const productId = `gid://shopify/Product/${quickAddBtn.dataset.productId || ""}`;
        const overrideRules = await fetchRules(catalogId, productId);
        const variants = await fetchVariantsForProduct(handle);
        const hiddenIds = buildHiddenVariantIds(overrideRules || rules, variants);
        if (hiddenIds.size > 0) hideOnProductPage(hiddenIds);
      }, 300);
    });
  }

  // Fetch variants for a product by handle using Shopify Ajax API
  async function fetchVariantsForProduct(handle) {
    try {
      const res = await fetch(`/products/${handle}.js`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.variants || [];
    } catch (e) {
      return [];
    }
  }

  // ─── MAIN ─────────────────────────────────────────────────────────────────

  async function init() {
    const catalogData = getCatalogData();
    if (!catalogData) return; // Not a B2B customer or catalog ID not set

    const { catalogId, productId } = catalogData;
    const rules = await fetchRules(catalogId, productId);
    if (!rules) return;

    const isProductPage = !!document.querySelector(
      "variant-selects, .product-form, [data-section-type='product']"
    );

    if (isProductPage) {
      const allVariants = getProductVariants();
      const hiddenIds = buildHiddenVariantIds(rules, allVariants);
      hideOnProductPage(hiddenIds);
    } else {
      // Collection / search / home page
      await hideOnCollectionPage(catalogId, rules);
    }
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();