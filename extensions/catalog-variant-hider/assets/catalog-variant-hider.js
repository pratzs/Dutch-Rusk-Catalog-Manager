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
          }
        });

        // 2. FORM & BUTTON LOGIC (The "Decision Engine")
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
          const container = form.closest('.product, .product-single, .card, .grid__item') || form;
          const btn = form.querySelector('button[name="add"], [type="submit"], .add-to-cart');
          
          // Get the actual variant ID Shopify is trying to sell
          const variantIdInput = form.querySelector('input[name="id"]');
          const currentVariantId = variantIdInput ? variantIdInput.value : null;

          // Also check the text label of the selected variant (for single-variant products)
          const variantLabel = container.querySelector('.variant-label, .product-variant-title, .selected-variant');
          const labelText = variantLabel ? variantLabel.textContent : "";

          // DECISION: Should we disable this specific product?
          const isIdHidden = currentVariantId && validIds.includes(currentVariantId);
          const isLabelHidden = validTypes.some(type => labelText.includes(type));
          const isThemeSingleVariantMatch = !form.querySelector('input[type="radio"], select') && validTypes.some(type => container.textContent.includes(type));

          if (isIdHidden || isLabelHidden || isThemeSingleVariantMatch) {
            if (btn && !btn.disabled) {
              btn.disabled = true;
              btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
              btn.style.opacity = "0.5";
              
              // Hide the extras (Inventory, Quantity, etc.)
              const extras = container.querySelectorAll('.inventory-pill, .inventory, [id^="Inventory"], .quantity-wrapper, quantity-input, variant-radios, variant-selects, .variant-wrapper, fieldset, .product-form__input');
              extras.forEach(item => item.style.setProperty('display', 'none', 'important'));
            }
          } else {
            // AUTO-SELECT for multi-variant products
            const allOptions = Array.from(form.querySelectorAll('input[type="radio"], option'));
            const selected = allOptions.find(o => (o.checked || o.selected) && o.dataset.cvhHidden === "true");
            
            if (selected) {
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