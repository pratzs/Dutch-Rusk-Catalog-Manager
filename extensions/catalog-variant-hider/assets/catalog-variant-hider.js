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

        const validTypes = rules.hiddenVariantTypes || [];
        const validIds = rules.hiddenVariantIds || [];

        // 1. HIDE SPECIFIC VARIANT ELEMENTS ONLY (No Card Hiding)
        document.querySelectorAll('input[type="radio"], label, option, .variant-picker__option-value').forEach(el => {
          const val = el.value || el.textContent?.trim() || "";
          if (!val) return;

          const isMatch = validTypes.some(type => val.includes(type)) || validIds.includes(val);

          if (isMatch) {
            el.dataset.cvhHidden = "true";
            el.style.display = "none";
            if (el.tagName === 'OPTION') el.disabled = true;
            
            // Hide only the small swatch/button wrapper, NEVER the whole product card
            const wrapper = el.closest(".swatch-element, .variant-option, .variant-input");
            if (wrapper) wrapper.style.display = "none";
          } else {
            el.dataset.cvhHidden = "false";
          }
        });

        // 2. EVALUATE FORMS FOR SOLD OUT / BACK SOON
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
          const container = form.closest('.product, .product-single, .card, .grid__item') || form;
          const btn = form.querySelector('button[name="add"], [type="submit"], .add-to-cart');
          
          // Get all inputs that represent product variants
          const allVariantInputs = Array.from(form.querySelectorAll('input[type="radio"], option'));
          
          let shouldDisable = false;

          if (allVariantInputs.length > 0) {
            // Check if every single option is hidden
            const hiddenOptions = allVariantInputs.filter(o => o.dataset.cvhHidden === "true" || o.style.display === "none");
            if (hiddenOptions.length === allVariantInputs.length) {
              shouldDisable = true;
            } else {
              // AUTO-SELECT logic for multi-variant products
              const currentChecked = allVariantInputs.find(o => (o.checked || o.selected) && o.dataset.cvhHidden === "true");
              if (currentChecked) {
                const nextAvailable = allVariantInputs.find(o => o.dataset.cvhHidden !== "true" && o.style.display !== "none");
                if (nextAvailable) {
                  if (nextAvailable.tagName === 'OPTION') {
                    nextAvailable.parentElement.value = nextAvailable.value;
                  } else {
                    nextAvailable.checked = true;
                    nextAvailable.click();
                  }
                  nextAvailable.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            }
          } else {
            // SINGLE VARIANT CASE: Check hidden ID or container specific variant text safely
            const hiddenIdInput = form.querySelector('input[name="id"]');
            if (hiddenIdInput && validIds.includes(hiddenIdInput.value)) {
              shouldDisable = true;
            }
            // Use specific variant labels rather than the whole container text
            const variantLabels = container.querySelectorAll('.variant-label, .product-variant-title');
            variantLabels.forEach(label => {
               if (validTypes.some(type => label.textContent.includes(type))) shouldDisable = true;
            });
          }

          if (shouldDisable && btn) {
            btn.disabled = true;
            btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
            btn.style.opacity = "0.5";

            // Aggressively hide details ONLY if the product is fully unavailable
            const extras = container.querySelectorAll('.inventory-pill, .inventory, [id^="Inventory"], .quantity-wrapper, quantity-input, variant-radios, variant-selects, .variant-wrapper, fieldset');
            extras.forEach(item => item.style.setProperty('display', 'none', 'important'));
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