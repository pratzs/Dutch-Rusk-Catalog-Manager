(function () {
  const APP_URL = "https://dutch-rusk-catalog-manager.onrender.com";
  let isProcessing = false;

  async function init() {
    const el = document.getElementById('catalog-variant-hider-data') || document.querySelector("[data-catalog-id]");
    if (!el) return;

    const { catalogId, productId } = el.dataset;
    const res = await fetch(`${APP_URL}/api/catalog-rules?catalogId=${catalogId}&productId=${productId || ''}`);
    const rules = await res.json();

    // When a product-level override exists, it is authoritative.
    // Blanket hiddenVariantTypes must NOT apply — only the explicit hiddenVariantIds list counts.
    const validTypes = rules.hasOverride ? [] : (rules.hiddenVariantTypes || []);
    const validIds = rules.hiddenVariantIds || [];

    if (validTypes.length > 0 || validIds.length > 0) {

      const applyRules = () => {
        if (isProcessing) return;
        isProcessing = true;

        const containers = document.querySelectorAll('.product, .product-single, .card, .grid__item, .product-section, [data-product-id], .product-item, .product__info-container');

        containers.forEach(container => {
          container.setAttribute('data-cvh-processed', '1');
          const content = container.textContent || "";
          
          // 1. Grab the selected SKU dynamically from Ignite's native elements
          const currentSkuElement = container.querySelector('.product__sku, [data-sku]');
          const currentSku = currentSkuElement ? currentSkuElement.textContent.trim() : "";
          
          const isForbiddenSkuSelected = validIds.includes(currentSku);

          // 2. Add SKU matching to the main logic
          const isMatch = validTypes.some(type => content.includes(type)) || isForbiddenSkuSelected || validIds.some(id => container.innerHTML.includes(id));

          if (isMatch) {
            const hasOtherOptions = content.includes("Bag") || content.includes("Outer") || container.querySelectorAll('input[type="radio"]:not([style*="none"])').length > 1;

            // 3. FORCE disable if they land on a forbidden SKU exception
            if (!hasOtherOptions || isForbiddenSkuSelected) {
              
              // A. UPDATE BUTTONS
              const btn = container.querySelector('button[name="add"], .add-to-cart, [type="submit"]');
              if (btn) {
                btn.disabled = true;
                btn.textContent = window.location.pathname.includes('/products/') ? "Sold out" : "Back soon";
                btn.style.opacity = "0.5";
              }

              // B. INJECT NATIVE SIDE-BY-SIDE SOLD OUT BADGE
              const badges = container.querySelectorAll('.badge, .card__badge, .product-badge, .sale-badge, .grid-product__badge');
              let badgeParent = null;
              let templateBadge = null;

              badges.forEach(b => {
                if (!b.querySelector('.badge, .card__badge, .product-badge')) {
                  badgeParent = b.parentElement;
                  templateBadge = b;
                }
              });

              if (badgeParent && templateBadge) {
                if (!badgeParent.textContent.toLowerCase().includes('sold out')) {
                  const soldOutBadge = templateBadge.cloneNode(true);
                  soldOutBadge.textContent = 'Sold out';
                  soldOutBadge.className = templateBadge.className.replace(/sale/g, 'sold-out').replace(/Sale/g, 'SoldOut');
                  soldOutBadge.style.setProperty('background-color', '#4a4a4a', 'important');
                  soldOutBadge.style.setProperty('color', '#ffffff', 'important');
                  soldOutBadge.style.setProperty('border-color', '#4a4a4a', 'important');
                  badgeParent.appendChild(soldOutBadge);
                }
              }

              // C. AGGRESSIVELY HIDE PRICES & STOCK
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
              // MULTI VARIANT - Hide restricted buttons only
              container.querySelectorAll('input, label, option, .swatch-element').forEach(item => {
                const val = item.value || item.textContent || "";
                if (validTypes.some(t => val.includes(t)) || validIds.some(id => val.includes(id))) {
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