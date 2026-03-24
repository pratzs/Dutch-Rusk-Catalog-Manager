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

        // 1. Locate the master product form (Universal Shopify standard)
        const productForms = document.querySelectorAll('form[action^="/cart/add"]');
        
        productForms.forEach(form => {
          let allVariantsHidden = true;
          let requiresChangeTrigger = false;
          let triggerElement = null;

          // --- SCENARIO A: Theme uses standard Dropdowns (<select>) ---
          form.querySelectorAll('select').forEach(select => {
            let hasVisibleOptionInThisSelect = false;

            Array.from(select.options).forEach(opt => {
              const val = opt.textContent.trim();
              const isMatch = rules.hiddenVariantTypes?.some(type => val.startsWith(type)) || rules.hiddenVariantIds?.includes(val) || rules.hiddenVariantIds?.includes(opt.value);
              
              if (isMatch) {
                opt.style.display = "none";
                opt.disabled = true; // Crucial for dropdowns
              } else {
                opt.style.display = "";
                opt.disabled = false;
                hasVisibleOptionInThisSelect = true;
              }
            });

            if (hasVisibleOptionInThisSelect) {
              allVariantsHidden = false;
              
              // Auto-select fallback if the currently selected option is hidden
              const selectedOpt = select.options[select.selectedIndex];
              if (!selectedOpt || selectedOpt.disabled || selectedOpt.style.display === "none") {
                const firstVisible = Array.from(select.options).find(o => !o.disabled && o.style.display !== "none");
                if (firstVisible) {
                  select.value = firstVisible.value;
                  requiresChangeTrigger = true;
                  triggerElement = select;
                }
              }
            }
          });

          // --- SCENARIO B: Theme uses Radio Buttons / Pills ---
          // Group radios by name to handle multiple option groups (e.g., Size, Color)
          const radioGroups = {};
          form.querySelectorAll('input[type="radio"]').forEach(radio => {
            if (!radioGroups[radio.name]) radioGroups[radio.name] = [];
            radioGroups[radio.name].push(radio);
          });

          Object.keys(radioGroups).forEach(groupName => {
            let hasVisibleRadioInThisGroup = false;
            const radios = radioGroups[groupName];

            radios.forEach(radio => {
              const label = form.querySelector(`label[for="${radio.id}"]`);
              const val = radio.value || (label ? label.textContent.trim() : "");
              const isMatch = rules.hiddenVariantTypes?.some(type => val.startsWith(type)) || rules.hiddenVariantIds?.includes(val);

              // Find the generic parent wrapper if it exists (li, fieldset, or a generic div)
              const wrapper = radio.closest('li, fieldset, div[class*="swatch"], div[class*="variant"]');

              if (isMatch) {
                radio.style.display = "none";
                if (label) label.style.display = "none";
                if (wrapper && wrapper.children.length <= 2) wrapper.style.display = "none"; // Only hide wrapper if it strictly belongs to this radio
              } else {
                hasVisibleRadioInThisGroup = true;
              }
            });

            if (hasVisibleRadioInThisGroup) {
              allVariantsHidden = false;

              // Auto-select fallback if the currently checked radio is hidden
              const checkedRadio = radios.find(r => r.checked);
              if (!checkedRadio || checkedRadio.style.display === "none") {
                const firstVisible = radios.find(r => r.style.display !== "none");
                if (firstVisible) {
                  firstVisible.checked = true;
                  requiresChangeTrigger = true;
                  triggerElement = firstVisible;
                }
              }
            }
          });

          // --- FINALIZE: Disable Cart OR Trigger Auto-Select ---
          const hasInputs = form.querySelectorAll('select, input[type="radio"]').length > 0;
          const addToCartBtns = form.querySelectorAll('[type="submit"], button[name="add"]');

          if (hasInputs && allVariantsHidden) {
            addToCartBtns.forEach(btn => {
              btn.disabled = true;
              btn.textContent = 'Unavailable';
              btn.style.opacity = '0.5';
            });
            // Hide generic quantity selectors
            const qtyContainers = form.querySelectorAll('input[name="quantity"], quantity-input');
            qtyContainers.forEach(qty => {
               const wrap = qty.closest('div');
               if(wrap) wrap.style.display = 'none';
            });
          } else if (requiresChangeTrigger && triggerElement) {
            console.log("🔄 [CatalogVariantHider] Auto-selecting fallback variant.");
            triggerElement.dispatchEvent(new Event('change', { bubbles: true }));
            if (triggerElement.type === 'radio') triggerElement.click(); // Ensures visual swatches update
          }
        });

        setTimeout(() => { isAdjusting = false; }, 100);
      };
      
      apply();
      // Watch for dynamic theme changes (AJAX cart, quick view, etc.)
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