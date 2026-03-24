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
      const validTypes = rules.hiddenVariantTypes || [];
      const validIds = rules.hiddenVariantIds || [];

      const apply = () => {
        if (isAdjusting) return;
        isAdjusting = true;

        // 1. VISUAL HIDING (Swatches/Dropdowns)
        document.querySelectorAll('input[type="radio"], option, label, .variant-picker__option-value').forEach(el => {
          const val = el.value || el.textContent?.trim() || "";
          if (!val) return;
          const isMatch = validTypes.some(type => val.includes(type)) || validIds.includes(val);

          if (isMatch) {
            el.dataset.cvhHidden = "true";
            el.style.display = "none";
            const wrapper = el.closest(".swatch-element, .variant-option, .variant-input");
            if (wrapper) wrapper.style.display = "none";
          } else {
             el.dataset.cvhHidden = "false";
             // Ensure it's visible if it doesn't match a rule
             const wrapper = el.closest(".swatch-element, .variant-option, .variant-input");
             if (wrapper) wrapper.style.display = "";
          }
        });

        // 2. FORM & BUTTON LOGIC
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
          const container = form.closest('.product, .product-single, .card, .grid__item') || form;
          const btn = form.querySelector('button[name="add"], [type="submit"], .add-to-cart');
          
          const allOptions = Array.from(form.querySelectorAll('input[type="radio"], option'));
          const visibleOptions = allOptions.filter(o => o.dataset.cvhHidden !== "true" && o.style.display !== "none");

          // DECISION A: Multi-variant product (like Bag + Shipper)
          if (allOptions.length > 0) {
            if (visibleOptions.length === 0) {
              // Everything is hidden
              disableProduct(btn, container);
            } else {
              // We have visible options (like the Bag)! Ensure button is enabled.
              enableProduct(btn, container);
              
              // Auto-select if current selection is a hidden one
              const selected = allOptions.find(o => (o.checked || o.selected) && o.dataset.cvhHidden === "true");
              if (selected) {
                console.log(`🔄 [CatalogVariantHider] Switching to visible option: ${visibleOptions[0].value}`);
                if (visibleOptions[0].tagName === 'OPTION') {
                  visibleOptions[0].parentElement.value = visibleOptions[0].value;
                } else {
                  visibleOptions[0].checked = true;
                  visibleOptions[0].click();
                }
                visibleOptions[0].dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          } 
          // DECISION B: Single-variant product (No radios/dropdowns)
          else {
            const variantIdInput = form.querySelector('input[name="id"]');
            const currentVariantId = variantIdInput ? variantIdInput.value : null;
            
            // For single variants, we check if the ID or the specific title matches
            const isIdHidden = currentVariantId && validIds.includes(currentVariantId);
            // Check ONLY the specific variant title label, not the whole card text
            const variantTitle = container.querySelector('.variant-label, .product-variant-title, .selected-variant');
            const isTitleHidden = variantTitle && validTypes.some(type => variantTitle.textContent.includes(type));

            if (isIdHidden || isTitleHidden) {
              disableProduct(btn, container);
            } else {
              enableProduct(btn, container);
            }
          }
        });

        function disableProduct(btn, container) {
          if (btn && !btn.disabled) {
            btn.disabled = true;
            btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
            btn.style.opacity = "0.5";
            const extras = container.querySelectorAll('.inventory-pill, .inventory, [id^="Inventory"], .quantity-wrapper, quantity-input, variant-radios, variant-selects, .variant-wrapper, fieldset, .product-form__input');
            extras.forEach(item => item.style.setProperty('display', 'none', 'important'));
          }
        }

        function enableProduct(btn, container) {
          if (btn && btn.disabled && (btn.textContent === "Sold out" || btn.textContent === "Back soon")) {
            btn.disabled = false;
            btn.textContent = "Add to cart";
            btn.style.opacity = "1";
            const extras = container.querySelectorAll('.inventory-pill, .inventory, [id^="Inventory"], .quantity-wrapper, quantity-input, variant-radios, variant-selects, .variant-wrapper, fieldset, .product-form__input');
            extras.forEach(item => item.style.display = "");
          }
        }

        setTimeout(() => { isAdjusting = false; }, 100);
      };

      apply();
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
    }

    init();
  })();
} catch (e) { console.error(e); }