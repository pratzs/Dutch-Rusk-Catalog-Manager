(function () {
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";
  let observer = null;

  async function init() {
    const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
    if (!el) return;

    const { catalogId, productId } = el.dataset;
    
    // Cache the rules so we don't spam Render
    const res = await fetch(`${APP_URL}/api/catalog-rules?catalogId=${catalogId}&productId=${productId || ''}`);
    const rules = await res.json();

    if (rules.hiddenVariantTypes?.length > 0 || rules.hiddenVariantIds?.length > 0) {
      const applyRules = () => {
        // 1. Temporarily stop watching to avoid infinite loops
        if (observer) observer.disconnect();

        const validTypes = rules.hiddenVariantTypes || [];
        const validIds = rules.hiddenVariantIds || [];
        const containers = document.querySelectorAll('.product, .product-single, .card, .grid__item, .product-section');

        containers.forEach(container => {
          const content = container.textContent || "";
          const isMatch = validTypes.some(type => content.includes(type)) || validIds.some(id => container.innerHTML.includes(id));

          if (isMatch) {
            const hasOtherOptions = content.includes("Bag") || content.includes("Outer") || container.querySelectorAll('input[type="radio"]:not([style*="none"])').length > 1;

            if (!hasOtherOptions) {
              // SINGLE VARIANT (Candy Floss)
              const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
              if (btn && !btn.disabled) {
                btn.disabled = true;
                btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
                btn.style.opacity = "0.5";
              }
              container.querySelectorAll('label, .inventory, .stock, .quantity, .variant-wrapper, [id^="Inventory"]').forEach(item => {
                const itemText = item.textContent || "";
                if (validTypes.some(t => itemText.includes(t)) || itemText.includes("Pack Size") || itemText.includes("stock") || item.closest('.quantity')) {
                  item.style.setProperty('display', 'none', 'important');
                }
              });
            } else {
              // MULTI VARIANT (Mackintosh's)
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

        // 2. Start watching again after changes are done
        startObserver();
      };

      const startObserver = () => {
        observer = new MutationObserver((mutations) => {
          // Only re-run if something significant changed (like a new product loading)
          // and not just a style change we made.
          const isSignificant = mutations.some(m => m.addedNodes.length > 0);
          if (isSignificant) applyRules();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      };

      applyRules();
    }
  }

  init();
})();