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
            const wrapper = el.closest(".swatch-element, .variant-option, .variant-input, li");
            if (wrapper && !wrapper.classList.contains('grid__item')) wrapper.style.display = "none";
          } else {
             el.dataset.cvhHidden = "false";
          }
        });

        // 2. FORM & BUTTON LOGIC
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
          const container = form.closest('.product, .product-single, .card, .grid__item') || form;
          const btn = form.querySelector('button[name="add"], [type="submit"], .add-to-cart');
          
          const allOptions = Array.from(form.querySelectorAll('input[type="radio"], option'));
          const visibleOptions = allOptions.filter(o => o.dataset.cvhHidden !== "true" && o.style.display !== "none");

          const variantIdInput = form.querySelector('input[name="id"]');
          const currentVariantId = variantIdInput ? variantIdInput.value : null;

          let shouldDisable = false;

          // CASE A: Multi-variant (Radios/Dropdowns exist)
          if (allOptions.length > 0) {
            if (visibleOptions.length === 0) {
              shouldDisable = true;
            } else {
              // Switch away from hidden default
              const selected = allOptions.find(o => (o.checked || o.selected) && o.dataset.cvhHidden === "true");
              if (selected) {
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
          // CASE B: Single-variant (Only a hidden ID input)
          else if (currentVariantId) {
            // If the active ID is in our 'Hidden IDs' list OR the product title/label contains a 'Hidden Type'
            const isIdHidden = validIds.includes(currentVariantId);
            const variantTitle = container.querySelector('.variant-label, .product-variant-title, .h1, .product__title');
            const isTitleHidden = variantTitle && validTypes.some(type => variantTitle.textContent.includes(type));
            
            if (isIdHidden || isTitleHidden) shouldDisable = true;
          }

          if (shouldDisable) {
            if (btn && !btn.disabled) {
              btn.disabled = true;
              btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
              btn.style.opacity = "0.5";
              container.querySelectorAll('.inventory-pill, .inventory, [id^="Inventory"], .quantity-wrapper, quantity-input, variant-radios, variant-selects, fieldset').forEach(item => {
                item.style.setProperty('display', 'none', 'important');
              });
            }
          } else if (btn && btn.disabled && (btn.textContent === "Sold out" || btn.textContent === "Back soon")) {
            // Re-enable if it's a Bag or other valid variant
            btn.disabled = false;
            btn.textContent = "Add to cart";
            btn.style.opacity = "1";
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