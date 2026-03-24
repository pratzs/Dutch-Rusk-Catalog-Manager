(function () {
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";
  let isProcessing = false; // The Silencer

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
        if (isProcessing) return; // Stop the loop
        isProcessing = true;

        const containers = document.querySelectorAll('.product, .product-single, .card, .grid__item, .product-section');

        containers.forEach(container => {
          const content = container.textContent || "";
          const isMatch = validTypes.some(type => content.includes(type)) || validIds.some(id => container.innerHTML.includes(id));

          if (isMatch) {
            // Check if there are other valid options like "Bag"
            const hasOtherOptions = content.includes("Bag") || content.includes("Outer") || container.querySelectorAll('input[type="radio"]:not([style*="none"])').length > 1;

            if (!hasOtherOptions) {
              // SCENARIO: Single-variant "Shipper" (The Candy Floss Case)
              const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
              if (btn) {
                btn.disabled = true;
                btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
                btn.style.opacity = "0.5";
              }

              // Target specific labels and inventory text
              container.querySelectorAll('label, .inventory, .stock, .quantity, .variant-wrapper, [id^="Inventory"]').forEach(item => {
                const itemText = item.textContent || "";
                if (validTypes.some(t => itemText.includes(t)) || itemText.includes("Pack Size") || itemText.includes("stock") || item.closest('.quantity')) {
                  item.style.setProperty('display', 'none', 'important');
                }
              });
            } else {
              // SCENARIO: Multi-variant (The Mackintosh's Case)
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

        // Release the silencer after a tiny delay
        setTimeout(() => { isProcessing = false; }, 100);
      };

      applyRules();
      
      // Watch for theme AJAX changes but ignore our own changes
      const observer = new MutationObserver((mutations) => {
        const shouldTrigger = mutations.some(m => !m.target.closest || !m.target.closest('[data-cvh-processed]'));
        if (shouldTrigger) applyRules();
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  init();
})();