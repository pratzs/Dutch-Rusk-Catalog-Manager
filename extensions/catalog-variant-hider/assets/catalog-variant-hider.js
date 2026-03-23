function hideOnProductPage(rules, allVariants) {
    const hiddenIds = buildHiddenVariantIds(rules, allVariants);
    if (hiddenIds.size === 0) return;

    const apply = () => {
      // 1. Target Ignite's Radio Inputs
      document.querySelectorAll("input[type='radio'], input[type='checkbox']").forEach(input => {
        if (hiddenIds.has(String(input.value))) {
          const wrapper = input.closest(".swatch-element, .variant-option, li, label, .variant-input") || input.parentElement;
          if (wrapper) wrapper.style.display = "none";
        }
      });

      // 2. Target Text Labels (Fallback for complex web components)
      document.querySelectorAll(".variant-picker__option-value, [data-option-value], label").forEach(el => {
        const text = el.textContent.trim();
        if (rules.hiddenVariantTypes?.some(type => text.startsWith(type))) {
          const wrapper = el.closest(".swatch-element, li, .variant-input") || el;
          wrapper.style.display = "none";
        }
      });
    };

    apply();
    setTimeout(apply, 600); // Wait for Ignite's JS to finish
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
  }