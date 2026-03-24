// High-priority execution
console.log("🚀 [CatalogVariantHider] Script file reached browser.");

try {
  (function () {
    const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

    async function init() {
      const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
      if (!el) return;

      const { catalogId, productId } = el.dataset;
      const res = await fetch(`${APP_URL}/api/catalog-rules?catalogId=${catalogId}&productId=${productId || ''}`);
      const rules = await res.json();

      if (rules.hiddenVariantTypes?.length > 0 || rules.hiddenVariantIds?.length > 0) {
        applyHiding(rules);
      }
    }

    function applyHiding(rules) {
      let isAdjusting = false;

      const apply = () => {
        if (isAdjusting) return;
        isAdjusting = true;

        const validTypes = (rules.hiddenVariantTypes || []);
        const validIds = (rules.hiddenVariantIds || []);

        // 1. HIDE THE VARIANT INPUTS/LABELS
        document.querySelectorAll('input[type="radio"], label, option, .variant-picker__option-value').forEach(el => {
          const val = el.value || el.textContent?.trim() || "";
          if (!val) return;

          const isMatch = validTypes.some(type => val.includes(type)) || validIds.includes(val);

          if (isMatch) {
            el.dataset.cvhHidden = "true";
            el.style.display = "none";
            if (el.tagName === 'OPTION') el.disabled = true;
            
            // Hide parent wrapper (the button/swatch container)
            const wrapper = el.closest(".swatch-element, .variant-option, li, .variant-input");
            if (wrapper) wrapper.style.display = "none";
          }
        });

        // 2. CHECK THE FORMS
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
          const container = form.closest('.product, .product-single, .card, .grid__item') || form;
          const btn = form.querySelector('button[name="add"], [type="submit"], .add-to-cart');
          
          // Count total variants vs hidden variants in this specific form
          const allOptions = Array.from(form.querySelectorAll('input[type="radio"], option'));
          const hiddenOptions = allOptions.filter(o => o.dataset.cvhHidden === "true" || o.style.display === "none");

          // If everything is hidden OR it's a single variant that matches our hidden rules
          const isSingleVariantMatch = allOptions.length === 0 && validTypes.some(type => container.textContent.includes(type));

          if ((allOptions.length > 0 && hiddenOptions.length === allOptions.length) || isSingleVariantMatch) {
            if (btn) {
              btn.disabled = true;
              btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
              btn.style.opacity = "0.5";
            }

            // AGGRESSIVELY HIDE THE EXTRAS
            const selectors = [
              '.inventory-pill', '.inventory', '.stock-level', '[id^="Inventory"]',
              '.quantity-wrapper', 'quantity-input', '.product-form__quantity',
              'variant-radios', 'variant-selects', '.variant-wrapper', 'fieldset'
            ];
            
            container.querySelectorAll(selectors.join(',')).forEach(item => {
              item.style.setProperty('display', 'none', 'important');
            });
          } 
          // Auto-select logic for multi-variant products
          else if (allOptions.length > 0) {
            const checked = allOptions.find(o => (o.checked || o.selected) && o.dataset.cvhHidden === "true");
            if (checked) {
              const firstVisible = allOptions.find(o => o.dataset.cvhHidden !== "true" && o.style.display !== "none");
              if (firstVisible) {
                if (firstVisible.tagName === 'OPTION') {
                  firstVisible.parentElement.value = firstVisible.value;
                } else {
                  firstVisible.checked = true;
                  firstVisible.click();
                }
                firstVisible.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }
        });

        setTimeout(() => { isAdjusting = false; }, 100);
      };

      apply();
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
    }

    init();
  })();
} catch (e) { console.error(e); }