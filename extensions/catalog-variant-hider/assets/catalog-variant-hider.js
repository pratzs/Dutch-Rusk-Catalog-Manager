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
      let isAdjusting = false;

      const apply = () => {
        if (isAdjusting) return;

        let hiddenAny = false;

        // 1. WIDE NET HIDING (Visual Hiding of Options)
        document.querySelectorAll("input, label, .variant-picker__option-value, option").forEach(el => {
          const val = el.value || el.textContent?.trim();
          if (!val) return;

          const isTypeMatch = rules.hiddenVariantTypes?.some(type => val.startsWith(type));
          const isIdMatch = rules.hiddenVariantIds?.includes(val);

          if (isTypeMatch || isIdMatch) {
            el.dataset.cvhHidden = "true"; 
            
            const wrapper = el.closest(".swatch-element, .variant-option, li, label, .variant-input") || el;
            if (wrapper) {
                wrapper.style.display = "none";
                hiddenAny = true;
            }
            if (el.tagName === 'OPTION') el.disabled = true;
          } else {
            el.dataset.cvhHidden = "false";
          }
        });

        if (!hiddenAny) return; 

        isAdjusting = true; 

        // 2. AUTO-SELECT LOGIC
        const addToCartBtns = document.querySelectorAll('button[name="add"], #AddToCart, .add-to-cart, button[type="submit"]');
        let allVariantsHidden = true; 

        // Check Radios / Swatches
        const allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
        const radioGroups = {};
        
        allRadios.forEach(r => {
            if (r.name) {
                if (!radioGroups[r.name]) radioGroups[r.name] = [];
                radioGroups[r.name].push(r);
            }
        });

        Object.keys(radioGroups).forEach(groupName => {
            const group = radioGroups[groupName];
            const visibleRadios = group.filter(r => r.dataset.cvhHidden !== "true");
            
            if (visibleRadios.length > 0) {
                allVariantsHidden = false; 
                const checkedRadio = group.find(r => r.checked);
                
                if (checkedRadio && checkedRadio.dataset.cvhHidden === "true") {
                    console.log(`🔄 [CatalogVariantHider] Auto-selecting radio: ${visibleRadios[0].value}`);
                    visibleRadios[0].checked = true;
                    visibleRadios[0].click(); 
                    visibleRadios[0].dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });

        // Check Standard Dropdowns (<select>)
        const allSelects = Array.from(document.querySelectorAll('select[name*="id"], select[name*="option"]'));
        allSelects.forEach(select => {
            const visibleOptions = Array.from(select.options).filter(o => o.dataset.cvhHidden !== "true");
            
            if (visibleOptions.length > 0) {
                allVariantsHidden = false;
                const selectedOpt = select.options[select.selectedIndex];
                
                if (selectedOpt && selectedOpt.dataset.cvhHidden === "true") {
                    console.log(`🔄 [CatalogVariantHider] Auto-selecting dropdown: ${visibleOptions[0].value}`);
                    select.value = visibleOptions[0].value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });

        // 3. COMPLETE HIDING & DISABLE CART (If EVERYTHING is hidden)
        if (allVariantsHidden && (allRadios.length > 0 || allSelects.length > 0)) {
             console.log("🚫 [CatalogVariantHider] All variants hidden. Disabling cart & hiding extras.");
             
             addToCartBtns.forEach(btn => {
                const isCollectionCard = btn.closest('.card, .product-item, .grid-item, .product-grid-item, .product-card');
                
                // Ensure it is actually an Add to Cart button
                if (btn.closest('form[action*="/cart"]') || btn.textContent.toLowerCase().includes('cart') || btn.textContent.toLowerCase().includes('add')) {
                    btn.disabled = true;
                    btn.textContent = isCollectionCard ? 'Back soon' : 'Sold out';
                    btn.style.opacity = '0.5';

                    // Find the container for this specific product (handles collection pages safely)
                    const productContainer = btn.closest('.product, .product-single, .card, .product-item, .grid-item, section') || btn.closest('form');

                    // A. Hide Quantity Selectors
                    productContainer.querySelectorAll('input[name="quantity"], quantity-input, .product-form__quantity').forEach(qty => {
                        const wrap = qty.closest('.quantity-wrapper, div');
                        if (wrap) wrap.style.display = 'none';
                    });

                    // B. Hide Variant Titles & Pickers entirely
                    productContainer.querySelectorAll('variant-radios, variant-selects, fieldset, .variant-wrapper, .product-form__input, .product-form__controls-group').forEach(picker => {
                        picker.style.display = 'none';
                    });

                    // C. Hide Inventory Pills
                    productContainer.querySelectorAll('.inventory-pill, .inventory, .stock-level, [id^="Inventory"]').forEach(pill => {
                        pill.style.display = 'none';
                    });
                }
             });
        }

        setTimeout(() => { isAdjusting = false; }, 100);
      };
      
      apply();
      // Watch for DOM changes (like AJAX loading)
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