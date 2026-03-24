(function () {
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";
  let isProcessing = false;

  async function init() {
    const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
    if (!el) return;

    const { catalogId, productId } = el.dataset;
    const res = await fetch(`${APP_URL}/api/catalog-rules?catalogId=${catalogId}&productId=${productId || ''}`);
    const rules = await res.json();

    if (rules.hiddenVariantTypes?.length > 0 || rules.hiddenVariantIds?.length > 0) {
      const validTypes = rules.hiddenVariantTypes || [];
      const validIds = rules.hiddenVariantIds || [];

      const applyRules = () => {
        if (isProcessing) return;
        isProcessing = true;

        const containers = document.querySelectorAll('.product, .product-single, .card, .grid__item, .product-section');

        containers.forEach(container => {
          const content = container.textContent || "";
          const isMatch = validTypes.some(type => content.includes(type)) || validIds.some(id => container.innerHTML.includes(id));

          if (isMatch) {
            // Check if there are "safe" variants available (like Bag or Outer)
            const hasOtherOptions = content.includes("Bag") || content.includes("Outer") || container.querySelectorAll('input[type="radio"]:not([style*="none"])').length > 1;

            if (!hasOtherOptions) {
              // 1. UPDATE BUTTONS
              const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
              if (btn) {
                btn.disabled = true;
                btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
                btn.style.opacity = "0.5";
              }

              // 2. TRIGGER THE THEME'S NATIVE SOLD OUT BADGE
              container.querySelectorAll('.badge, .card__badge, .product-badge, .sale-badge, .grid-product__badge').forEach(badge => {
                badge.textContent = 'Sold out';
                // Remove the theme's 'sale' classes so it drops the red color
                badge.classList.remove('badge--sale', 'card__badge--sale', 'sale-badge', 'grid-product__badge--sale');
                // Add the theme's standard 'sold out' classes
                badge.classList.add('badge--sold-out', 'card__badge--sold-out', 'sold-out-badge', 'grid-product__badge--sold-out');
                
                // Clear any inline styles that might be overriding the theme
                badge.style.backgroundColor = '';
                badge.style.color = '';
                badge.style.borderColor = '';
              });

              // 3. AGGRESSIVELY HIDE PRICES & STOCK
              const extras = container.querySelectorAll('label, .inventory, .stock, .quantity, .variant-wrapper, [id^="Inventory"], .price, [class*="price"], [class*="stock"], [class*="inventory"]');
              
              extras.forEach(item => {
                const itemText = (item.textContent || "").toLowerCase();
                const validTypesLower = validTypes.map(t => t.toLowerCase());
                const classStr = (typeof item.className === 'string') ? item.className.toLowerCase() : "";

                if (
                  validTypesLower.some(t => itemText.includes(t)) || 
                  itemText.includes("pack size") || 
                  itemText.includes("in stock") || 
                  itemText.includes("stock") ||
                  item.closest('.quantity') ||
                  classStr.includes('price') ||
                  classStr.includes('stock') ||
                  classStr.includes('inventory')
                ) {
                  item.style.setProperty('display', 'none', 'important');
                }
              });

            } else {
              // MULTI VARIANT - Just hide the Shipper buttons
              container.querySelectorAll('input, label, option, .swatch-element').forEach(item => {
                const val = item.value || item.textContent || "";
                if (validTypes.some(t => val.includes(t))) {
                  item.style.setProperty('display', 'none', 'important');
                  const wrap = item.closest('.swatch-element, .variant-input, li');
                  if (wrap && !wrap.classList.contains('grid__item')) {
                    wrap.style.setProperty('display', 'none', 'important');
                  }
                }
              });
            }
          }
        });

        setTimeout(() => { isProcessing = false; }, 100);
      };

      applyRules();
      
      const observer = new MutationObserver((mutations) => {
        const shouldTrigger = mutations.some(m => !m.target.closest || !m.target.closest('[data-cvh-processed]'));
        if (shouldTrigger) applyRules();
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  init();
})();