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

        // 1. HIDE ALL MATCHING INPUTS/LABELS
        document.querySelectorAll('input[type="radio"], option, label, .variant-picker__option-value, .swatch-element').forEach(el => {
          const val = el.value || el.textContent?.trim() || "";
          if (validTypes.some(type => val.includes(type)) || validIds.includes(val)) {
            el.dataset.cvhHidden = "true";
            el.style.setProperty('display', 'none', 'important');
            const wrapper = el.closest(".swatch-element, .variant-option, .variant-input, li");
            if (wrapper && !wrapper.classList.contains('grid__item')) {
                wrapper.style.setProperty('display', 'none', 'important');
            }
          }
        });

        // 2. SCAN FORMS & KILL BUTTONS
        document.querySelectorAll('form[action*="/cart"]').forEach(form => {
          const container = form.closest('.product, .product-single, .card, .grid__item') || form;
          const btn = form.querySelector('button[name="add"], [type="submit"], .add-to-cart');
          
          const allVariantElements = Array.from(form.querySelectorAll('input[type="radio"], option'));
          const visibleVariants = allVariantElements.filter(o => o.dataset.cvhHidden !== "true" && o.style.display !== "none");

          let shouldDisable = false;

          // IF MULTI-VARIANT: Disable only if ALL are hidden
          if (allVariantElements.length > 0) {
            if (visibleVariants.length === 0) shouldDisable = true;
          } 
          // IF SINGLE-VARIANT (Candy Floss Case): Check Title and ID
          else {
            const currentId = form.querySelector('input[name="id"]')?.value;
            const productTitle = container.querySelector('.product__title, .h1, h1')?.textContent || "";
            const variantText = container.querySelector('.variant-label, .product-variant-title')?.textContent || "";
            
            const isIdHidden = validIds.includes(currentId);
            const isTextHidden = validTypes.some(type => productTitle.includes(type) || variantText.includes(type));
            
            if (isIdHidden || isTextHidden) shouldDisable = true;
          }

          if (shouldDisable && btn) {
            btn.disabled = true;
            btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
            btn.style.opacity = "0.5";

            // AGGRESSIVE HIDING of "Pack Size", "Inventory", and "Quantity"
            const extras = container.querySelectorAll('.inventory-pill, .inventory, [id^="Inventory"], .quantity-wrapper, quantity-input, .product-form__input, .product__tax, .product-form__quantity, label');
            extras.forEach(item => {
                // If the item contains the hidden keyword or common labels, hide it
                const text = item.textContent || "";
                if (validTypes.some(t => text.includes(t)) || text.includes("Pack Size") || text.includes("stock") || item.closest('.quantity-wrapper')) {
                    item.style.setProperty('display', 'none', 'important');
                }
            });
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