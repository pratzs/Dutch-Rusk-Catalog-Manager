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

        const validTypes = (rules.hiddenVariantTypes || []).filter(t => t && t.trim() !== "");
        const validIds = rules.hiddenVariantIds || [];

        // 1. PRECISION HIDING 
        document.querySelectorAll('input[type="radio"], select option, label, .variant-picker__option-value').forEach(el => {
          if (el.name && el.name.toLowerCase().includes('quantity')) return;

          const val = el.value || el.textContent?.trim() || "";
          if (!val) return;

          const isTypeMatch = validTypes.some(type => val.includes(type.trim()));
          const isIdMatch = validIds.includes(val);

          if (isTypeMatch || isIdMatch) {
            el.dataset.cvhHidden = "true"; 
            
            if (el.tagName === 'OPTION') {
                el.disabled = true;
                el.style.display = "none";
            } else if (el.tagName === 'INPUT' && el.type === 'radio') {
                el.style.display = "none";
                if (el.id) {
                    const linkedLabel = document.querySelector(`label[for="${el.id}"]`);
                    if (linkedLabel) {
                        linkedLabel.style.display = "none";
                        linkedLabel.dataset.cvhHidden = "true";
                    }
                }
            } else {
                el.style.display = "none";
            }

            // GROUP PROTECTION & BLAST SHIELD
            const wrapper = el.closest(".swatch-element, .variant-option, li, .variant-input");
            if (wrapper && wrapper.tagName !== 'BODY') {
                // BLAST SHIELD: Never hide a container if it holds a form or a button (prevents hiding whole product cards)
                if (!wrapper.querySelector('form') && !wrapper.querySelector('button')) {
                    const siblings = wrapper.querySelectorAll('input[type="radio"], option');
                    if (siblings.length <= 1) {
                        wrapper.style.display = "none";
                    }
                }
            }
          } else {
            if (el.dataset.cvhHidden !== "true") {
                el.dataset.cvhHidden = "false";
            }
          }
        });

        // 2. FORM EVALUATION (Auto-select & Complete Disabling)
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
             const isCollectionCard = !!form.closest('.card, .product-item, .grid-item, .product-grid-item, .product-card, .grid__item');
             const container = form.closest('.product, .product-single, .card, .product-item, .grid-item, .grid__item, section') || form;
             
             let shouldDisable = false;

             const allRadios = Array.from(form.querySelectorAll('input[type="radio"]')).filter(r => !r.name?.toLowerCase().includes('quantity'));
             const allOptions = Array.from(form.querySelectorAll('select option'));
             
             // SCENARIO A: Multi-Variant Product
             if (allRadios.length > 0 || allOptions.length > 0) {
                 let allInteractiveHidden = true;

                 // Check Radios
                 const radioGroups = {};
                 allRadios.forEach(r => {
                     const name = r.name || 'unnamed';
                     if (!radioGroups[name]) radioGroups[name] = [];
                     radioGroups[name].push(r);
                 });

                 Object.keys(radioGroups).forEach(groupName => {
                     const group = radioGroups[groupName];
                     const visibleRadios = group.filter(r => r.dataset.cvhHidden !== "true");
                     
                     if (visibleRadios.length > 0) {
                         allInteractiveHidden = false; 
                         const checkedRadio = group.find(r => r.checked);
                         
                         if (checkedRadio && checkedRadio.dataset.cvhHidden === "true") {
                             console.log(`🔄 [CatalogVariantHider] Auto-selecting radio: ${visibleRadios[0].value}`);
                             visibleRadios[0].checked = true;
                             visibleRadios[0].click(); 
                             visibleRadios[0].dispatchEvent(new Event('change', { bubbles: true }));
                         }
                     }
                 });

                 // Check Selects
                 form.querySelectorAll('select').forEach(select => {
                     const options = Array.from(select.options);
                     const visibleOptions = options.filter(o => o.dataset.cvhHidden !== "true" && !o.disabled);
                     
                     if (visibleOptions.length > 0) {
                         allInteractiveHidden = false;
                         const selectedOpt = select.options[select.selectedIndex];
                         
                         if (selectedOpt && (selectedOpt.dataset.cvhHidden === "true" || selectedOpt.disabled)) {
                             console.log(`🔄 [CatalogVariantHider] Auto-selecting dropdown: ${visibleOptions[0].value}`);
                             select.value = visibleOptions[0].value;
                             select.dispatchEvent(new Event('change', { bubbles: true }));
                         }
                     }
                 });

                 shouldDisable = allInteractiveHidden;
             } 
             // SCENARIO B: Single Variant Fallback
             else {
                 const hiddenIdInput = form.querySelector('input[name="id"]');
                 const currentId = hiddenIdInput ? hiddenIdInput.value : null;
                 if (currentId && validIds.includes(currentId)) {
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