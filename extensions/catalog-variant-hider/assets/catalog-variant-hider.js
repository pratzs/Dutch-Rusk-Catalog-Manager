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
      let isAdjusting = false; // Prevents infinite loops when we programmatically click variants

      const apply = () => {
        if (isAdjusting) return;

        console.log("🚫 [CatalogVariantHider] Hiding elements...");
        
        // 1. Hide matching elements
        document.querySelectorAll("input, label, .variant-picker__option-value, option").forEach(el => {
          const val = el.value || el.textContent.trim();
          const isTypeMatch = rules.hiddenVariantTypes?.some(type => val.startsWith(type));
          const isIdMatch = rules.hiddenVariantIds?.includes(val);

          if (isTypeMatch || isIdMatch) {
            const wrapper = el.closest(".swatch-element, .variant-option, li, label, .variant-input") || el;
            wrapper.style.display = "none";
          }
        });

        // 2. Handle Auto-Select and Sold Out states
        isAdjusting = true; 
        
        const addToCartBtn = document.querySelector('button[name="add"], #AddToCart, .add-to-cart');
        
        const disableCart = () => {
          if (addToCartBtn && !addToCartBtn.disabled) {
            console.log("🚫 [CatalogVariantHider] All variants hidden. Disabling cart button.");
            addToCartBtn.disabled = true;
            addToCartBtn.textContent = 'Unavailable';
            addToCartBtn.style.opacity = '0.5';
            
            // Hide quantity selector
            const qty = document.querySelector('.quantity-wrapper, quantity-input, .product-form__quantity, input[name="quantity"]');
            if (qty) {
                const qtyWrapper = qty.closest('.quantity-wrapper, .product-form__input') || qty;
                qtyWrapper.style.display = 'none';
            }
          }
        };

        // Handle Radio Buttons / Visual Swatches
        const variantRadios = Array.from(document.querySelectorAll('input[type="radio"][name*="option"]'));
        if (variantRadios.length > 0) {
          const visibleRadios = variantRadios.filter(radio => {
            const wrapper = radio.closest(".swatch-element, .variant-option, li, label, .variant-input") || radio;
            return wrapper.style.display !== "none";
          });

          if (visibleRadios.length === 0) {
            disableCart();
          } else {
            const currentlySelected = variantRadios.find(r => r.checked);
            const wrapper = currentlySelected ? (currentlySelected.closest(".swatch-element, .variant-option, li, label, .variant-input") || currentlySelected) : null;
            
            if (wrapper && wrapper.style.display === "none") {
              console.log(`🔄 [CatalogVariantHider] Default hidden. Auto-selecting: ${visibleRadios[0].value}`);
              visibleRadios[0].checked = true;
              visibleRadios[0].click(); // Triggers the theme's JS
              visibleRadios[0].dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }

        // Handle Select Dropdowns
        const variantSelects = Array.from(document.querySelectorAll('select[name*="option"], select[name="id"]'));
        if (variantSelects.length > 0) {
           variantSelects.forEach(select => {
             const visibleOptions = Array.from(select.options).filter(opt => opt.style.display !== "none");
             
             if (visibleOptions.length === 0) {
                disableCart();
             } else {
                const selectedOption = select.options[select.selectedIndex];
                if (selectedOption && selectedOption.style.display === "none") {
                    console.log(`🔄 [CatalogVariantHider] Default hidden. Auto-selecting: ${visibleOptions[0].value}`);
                    select.value = visibleOptions[0].value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
             }
           });
        }

        // Resume observer logic after theme JS finishes rendering
        setTimeout(() => { isAdjusting = false; }, 50);
      };
      
      apply();
      // Watch for theme changes
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init);
    }
  })();
} catch (e) {
  console.error("❌ [CatalogVariantHider] Critical Script Error:", e);
}