(function () {
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";

  async function init() {
    const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
    if (!el) return;

    const { catalogId, productId } = el.dataset;
    const res = await fetch(`${APP_URL}/api/catalog-rules?catalogId=${catalogId}&productId=${productId || ''}`);
    const rules = await res.json();

    if (rules.hiddenVariantTypes?.length > 0 || rules.hiddenVariantIds?.length > 0) {
      const validTypes = rules.hiddenVariantTypes || [];
      const validIds = rules.hiddenVariantIds || [];

      const nuke = () => {
        // 1. Target every single product container on the page (Product Page or Collection)
        const containers = document.querySelectorAll('.product, .product-single, .card, .grid__item, .product-section, main');

        containers.forEach(container => {
          const text = container.textContent || "";
          const isMatch = validTypes.some(type => text.includes(type)) || validIds.some(id => text.includes(id));

          // 2. If this container mentions a hidden type (like "Shipper")
          if (isMatch) {
            // Check if there are "Safe" variants like "Bag" or "Outer" also present
            const hasSafeVariant = text.includes("Bag") || text.includes("Outer") || text.includes("Pack");
            
            // If it's ONLY a Shipper (no other safe words found) OR the active ID is hidden
            if (!hasSafeVariant || validIds.some(id => container.innerHTML.includes(id))) {
              
              // HIDE THE EXTRAS PERMANENTLY
              const selectors = [
                'button[name="add"]', '.add-to-cart', '[type="submit"]',
                '.inventory-pill', '.inventory', '.stock', '[id^="Inventory"]',
                '.quantity', 'quantity-input', '.product-form__input', 'fieldset', '.variant-wrapper'
              ];

              container.querySelectorAll(selectors.join(',')).forEach(el => {
                // If it's the button, change it to Sold Out first
                if (el.tagName === 'BUTTON' || el.type === 'submit') {
                  el.disabled = true;
                  el.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
                  el.style.opacity = "0.5";
                } else {
                  // Otherwise, just make it vanish
                  el.style.setProperty('display', 'none', 'important');
                  el.style.setProperty('visibility', 'hidden', 'important');
                  el.style.setProperty('height', '0', 'important');
                }
              });
            } else {
              // It's a Multi-variant product (Bag + Shipper)
              // Only hide the specific "Shipper" buttons/swatches
              container.querySelectorAll('input, label, option, .swatch-element').forEach(item => {
                if (validTypes.some(t => item.textContent.includes(t) || item.value?.includes(t))) {
                  item.style.setProperty('display', 'none', 'important');
                  const wrap = item.closest('.swatch-element, .variant-input, li');
                  if (wrap) wrap.style.setProperty('display', 'none', 'important');
                }
              });
            }
          }
        });
      };

      // Run immediately and then watch like a hawk
      nuke();
      new MutationObserver(nuke).observe(document.body, { childList: true, subtree: true });
    }
  }

  init();
})();