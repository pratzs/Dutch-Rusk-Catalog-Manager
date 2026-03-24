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
        isAdjusting = true;

        // 1. WIDE NET HIDING (Visual Hiding of Options)
        document.querySelectorAll("input, label, .variant-picker__option-value, option").forEach(el => {
          const val = el.value || el.textContent?.trim();
          if (!val) return;

          // UPGRADE: Use .includes() to catch things like "BLUE18_Shipper" when rule is "Shipper"
          const isTypeMatch = rules.hiddenVariantTypes?.some(type => val.includes(type));
          const isIdMatch = rules.hiddenVariantIds?.includes(val);

          if (isTypeMatch || isIdMatch) {
            el.dataset.cvhHidden = "true"; 
            
            const wrapper = el.closest(".swatch-element, .variant-option, li, label, .variant-input") || el;
            if (wrapper && wrapper.tagName !== 'BODY') {
                wrapper.style.display = "none";
            }
            if (el.tagName === 'OPTION') el.disabled = true;
          } else {
            el.dataset.cvhHidden = "false";
          }
        });

        // 2. FORM EVALUATION (Auto-select & Complete Disabling)
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
             const isCollectionCard = !!form.closest('.card, .product-item, .grid-item, .product-grid-item, .product-card');
             const container = form.closest('.product, .product-single, .card, .product-item, .grid-item, section') || form;
             
             let shouldDisable = false;

             const allRadios = Array.from(form.querySelectorAll('input[type="radio"]'));
             const allOptions = Array.from(form.querySelectorAll('select option'));
             
             // SCENARIO A: Multi-Variant Product (Radios or Selects exist)
             if (allRadios.length > 0 || allOptions.length > 0) {
                 let allInteractiveHidden = true;

                 // Radios
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
                         allInteractiveHidden = false; // Found a visible variant!
                         const checkedRadio = group.find(r => r.checked);
                         
                         if (checkedRadio && checkedRadio.dataset.cvhHidden === "true") {
                             console.log(`🔄 [CatalogVariantHider] Auto-selecting radio: ${visibleRadios[0].value}`);
                             visibleRadios[0].checked = true;
                             visibleRadios[0].click(); 
                             visibleRadios[0].dispatchEvent(new Event('change', { bubbles: true }));
                         }
                     }
                 });

                 // Selects
                 form.querySelectorAll('select').forEach(select => {
                     const options = Array.from(select.options);
                     const visibleOptions = options.filter(o => o.dataset.cvhHidden !== "true");
                     
                     if (visibleOptions.length > 0) {
                         allInteractiveHidden = false;
                         const selectedOpt = select.options[select.selectedIndex];
                         
                         if (selectedOpt && selectedOpt.dataset.cvhHidden === "true") {
                             console.log(`🔄 [CatalogVariantHider] Auto-selecting dropdown: ${visibleOptions[0].value}`);
                             select.value = visibleOptions[0].value;
                             select.dispatchEvent(new Event('change', { bubbles: true }));
                         }
                     }
                 });

                 shouldDisable = allInteractiveHidden;
             } 
             // SCENARIO B: Collection Card or Single-Variant Product (No visual options)
             else {
                 const hiddenIdInput = form.querySelector('input[name="id"]');
                 const currentId = hiddenIdInput ? hiddenIdInput.value : null;
                 const containerText = container.textContent || "";
                 
                 const idMatch = currentId && rules.hiddenVariantIds?.includes(currentId);
                 const typeMatch = rules.hiddenVariantTypes?.some(type => containerText.includes(type));

                 if (idMatch || typeMatch) {
                     shouldDisable = true;
                 }
             }

             // 3. APPLY DISABLE STYLES & HIDE EXTRAS
             if (shouldDisable) {
                  const btn = form.querySelector('button[name="add"], #AddToCart, .add-to-cart, button[type="submit"]');
                  
                  if (btn && !btn.disabled) {
                      console.log(`🚫 [CatalogVariantHider] Disabling cart for ${isCollectionCard ? 'Collection Card' : 'Product Page'}`);
                      btn.disabled = true;
                      btn.textContent = isCollectionCard ? 'Back soon' : 'Sold out';
                      btn.style.opacity = '0.5';

                      // Aggressively hide Inventory, Quantities, and Variant Labels
                      // Safety check included so we don't accidentally hide the submit button container
                      const elementsToHide = container.querySelectorAll('.inventory-pill, .inventory, .stock-level, [id^="Inventory"], .quantity-wrapper, quantity-input, .product-form__quantity, variant-radios, variant-selects, fieldset, .variant-wrapper, .product-form__input, .product-form__controls-group');
                      
                      elementsToHide.forEach(el => {
                          if (!el.querySelector('button[name="add"], button[type="submit"]')) {
                              el.style.display = 'none';
                          }
                      });
                  }
             }
        });

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