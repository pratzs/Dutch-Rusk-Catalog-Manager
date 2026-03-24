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
            const hasOtherOptions = content.includes("Bag") || content.includes("Outer") || container.querySelectorAll('input[type="radio"]:not([style*="none"])').length > 1;

            if (!hasOtherOptions) {
              // 1. UPDATE BUTTONS
              const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
              if (btn) {
                btn.disabled = true;
                btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
                btn.style.opacity = "0.5";
              }

              // 2. INJECT NATIVE SIDE-BY-SIDE SOLD OUT BADGE
              const badges = container.querySelectorAll('.badge, .card__badge, .product-badge, .sale-badge, .grid-product__badge');
              let badgeParent = null;
              let templateBadge = null;

              badges.forEach(b => {
                // Ignore wrappers by ensuring this element doesn't contain other badges inside it
                if (!b.querySelector('.badge, .card__badge, .product-badge')) {
                  badgeParent = b.parentElement;
                  templateBadge = b;
                }
              });

              if (badgeParent && templateBadge) {
                // Make sure we haven't already added one
                if (!badgeParent.textContent.toLowerCase().includes('sold out')) {
                  const soldOutBadge = templateBadge.cloneNode(true);
                  soldOutBadge.textContent = 'Sold out';
                  
                  // Swap theme sale classes for sold-out classes
                  soldOutBadge.className = templateBadge.className.replace(/sale/g, 'sold-out').replace(/Sale/g, 'SoldOut');
                  
                  // Force the dark grey theme colors to match your screenshot perfectly
                  soldOutBadge.style.setProperty('background-color', '#4a4a4a', 'important');
                  soldOutBadge.style.setProperty('color', '#ffffff', 'important');
                  soldOutBadge.style.setProperty('border-color', '#4a4a4a', 'important');
                  
                  // Add it right next to the sale badge
                  badgeParent.appendChild(soldOutBadge);
                }
              }

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
              // MULTI VARIANT - Hide Shipper buttons only
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