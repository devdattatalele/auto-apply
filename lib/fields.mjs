/**
 * fields.mjs — Universal field finder, dropdown handler, and fuzzy matching
 *
 * Handles React Select (Greenhouse), ARIA dropdowns (Ashby/Lever),
 * native selects, custom selects, and every other pattern we've encountered.
 */

// ─── Fuzzy text matching ────────────────────────────────────────────────────
// Score how well two strings match (0 = no match, 1 = exact)
export function fuzzyScore(needle, haystack) {
  const a = needle.toLowerCase().trim();
  const b = haystack.toLowerCase().trim();
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  const overlap = aWords.filter(w => bWords.some(bw => bw.includes(w) || w.includes(bw)));
  return overlap.length / Math.max(aWords.length, bWords.length) * 0.6;
}

// ─── Universal element finder ───────────────────────────────────────────────
// Tries multiple strategies to locate a form field. No hardcoded portal logic.
export async function findField(page, entry) {
  const { selector, id, name, label } = entry;
  const strategies = [
    // 1. Direct selector from scan
    async () => selector ? await page.$(selector) : null,
    // 2. By ID
    async () => id ? await page.$(`#${CSS.escape(id)}`) : null,
    // 3. By name
    async () => name ? await page.$(`[name="${name}"]`) : null,
    // 4. Playwright's getByLabel (the most robust for accessible forms)
    async () => {
      if (!label) return null;
      const cleanLabel = label.replace(/\*+/g, '').trim();
      if (!cleanLabel) return null;
      try {
        const loc = page.getByLabel(cleanLabel, { exact: false });
        if (await loc.count() > 0) return await loc.first().elementHandle();
      } catch { /* label not found */ }
      return null;
    },
    // 5. Find input near label text (for custom layouts)
    async () => {
      if (!label) return null;
      const cleanLabel = label.replace(/\*+/g, '').trim();
      if (!cleanLabel) return null;
      for (const combo of [
        `label:has-text("${cleanLabel}") + input`,
        `label:has-text("${cleanLabel}") + div input`,
        `label:has-text("${cleanLabel}") ~ input`,
        `label:has-text("${cleanLabel}") ~ div input`,
        `label:has-text("${cleanLabel}") + textarea`,
        `label:has-text("${cleanLabel}") + select`,
      ]) {
        try {
          const el = await page.$(combo);
          if (el) return el;
        } catch { /* invalid selector, skip */ }
      }
      return null;
    },
  ];

  for (const strategy of strategies) {
    try {
      const el = await strategy();
      if (el) return el;
    } catch { /* try next */ }
  }
  return null;
}

// ─── Option selectors for dropdown scanning ─────────────────────────────────
const OPTION_SELECTORS = [
  '.select__option',                      // React Select (Greenhouse)
  '[role="option"]',                       // ARIA standard (Lever, Ashby)
  '.select2-results__option',              // Select2 (legacy ATS)
  '[class*="menu"] [class*="option"]',     // CSS module pattern
  '[class*="listbox"] [class*="option"]',  // ARIA listbox pattern
  'li[class*="option"]',                   // Lever, BambooHR
  '.dropdown-item',                        // Bootstrap-based ATS
  'div[data-value]',                       // Workday custom selects
  '.css-option, .css-1n7v3ny-option',      // Emotion/styled-components
  'ul.dropdown-content li',                // Materialize-based
  '[class*="MenuItem"]',                   // MUI Select
];

// ─── Universal dropdown handler ─────────────────────────────────────────────
export async function handleDropdown(page, element, value, label) {
  // Strategy 1: Try native <select> first
  const tagName = await element.evaluate(el => el.tagName.toLowerCase());
  if (tagName === 'select') {
    try {
      await element.selectOption({ label: value });
      return { success: true, method: 'native-select' };
    } catch {
      try {
        await element.selectOption({ value });
        return { success: true, method: 'native-select-value' };
      } catch { /* not a simple select */ }
    }
  }

  // Strategy 2: Type-to-filter + click (best for React Select / searchable dropdowns)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await element.scrollIntoViewIfNeeded();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await element.click();
      await page.waitForTimeout(300);
      await element.fill('');
      await page.waitForTimeout(200);

      await element.type(value.substring(0, 15), { delay: 80 });
      await page.waitForTimeout(800 * attempt);

      let bestMatch = null;
      let bestScore = 0;

      for (const optSel of OPTION_SELECTORS) {
        const options = await page.$$(optSel);
        if (options.length === 0) continue;

        for (const opt of options) {
          const isVisible = await opt.isVisible().catch(() => false);
          if (!isVisible) continue;
          const text = await opt.textContent().catch(() => '');
          const trimmed = text.trim();
          if (!trimmed || trimmed === 'No options') continue;

          const score = fuzzyScore(value, trimmed);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = opt;
          }
        }
        if (bestMatch && bestScore >= 0.5) break;
      }

      if (bestMatch && bestScore >= 0.3) {
        await bestMatch.click();
        await page.waitForTimeout(600);

        const verified = await verifyDropdownFilled(page, element, value);
        if (verified) {
          return { success: true, method: 'type-filter', score: bestScore, attempt };
        }
        if (attempt < 3) {
          console.log(`    ↻ Clicked but value didn't stick, retry ${attempt}/3 for "${label || 'unknown'}"...`);
          continue;
        }
      } else if (attempt < 3) {
        console.log(`    ↻ No matching option, retry ${attempt}/3 for "${label || 'unknown'}"...`);
      }
    } catch (err) {
      if (attempt < 3) {
        console.log(`    ↻ Error attempt ${attempt}/3: ${err.message?.substring(0, 60)}`);
      }
    }
  }

  // Strategy 3: Click to open + scan all options (non-searchable dropdowns)
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await element.scrollIntoViewIfNeeded();
    await element.click();
    await page.waitForTimeout(1000);

    const allOptions = await page.$$(OPTION_SELECTORS.join(', '));
    let bestMatch = null;
    let bestScore = 0;

    for (const opt of allOptions) {
      const isVisible = await opt.isVisible().catch(() => false);
      if (!isVisible) continue;
      const text = await opt.textContent().catch(() => '');
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 100) continue;
      const score = fuzzyScore(value, trimmed);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = opt;
      }
    }

    if (bestMatch && bestScore >= 0.3) {
      await bestMatch.click();
      await page.waitForTimeout(600);
      const verified = await verifyDropdownFilled(page, element, value);
      return { success: verified, method: verified ? 'click-scan' : 'click-scan-unverified', score: bestScore };
    }
  } catch { /* click-scan failed */ }

  // Strategy 4: Keyboard navigation
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await element.click();
    await page.waitForTimeout(300);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(80);
      const active = await page.$('.select__option--is-focused, [role="option"][aria-selected="true"], .option.highlighted');
      if (active) {
        const text = await active.textContent().catch(() => '');
        if (fuzzyScore(value, text.trim()) >= 0.5) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
          const verified = await verifyDropdownFilled(page, element, value);
          return { success: verified, method: 'keyboard-nav' };
        }
      }
    }
  } catch { /* keyboard nav failed */ }

  return { success: false, method: 'all-strategies-failed' };
}

// ─── Verify a dropdown actually has a value ─────────────────────────────────
export async function verifyDropdownFilled(page, element, expectedValue) {
  // Method 1: React Select — check for .select__single-value
  try {
    const container = await element.evaluateHandle(el => {
      return el.closest('[class*="container"]') || el.closest('.select') || el.closest('.field');
    });
    if (container) {
      const singleValue = await container.$('.select__single-value, [class*="singleValue"]');
      if (singleValue) {
        const text = await singleValue.textContent().catch(() => '');
        if (text && text.trim() !== '' && text.trim() !== 'Select...') return true;
      }
      const multiValues = await container.$$('.select__multi-value, [class*="multiValue"]');
      if (multiValues && multiValues.length > 0) return true;
      const placeholder = await container.$('.select__placeholder');
      if (!placeholder) return true;
      const placeholderVisible = await placeholder.isVisible().catch(() => true);
      if (!placeholderVisible) return true;
    }
  } catch { /* container check failed */ }

  // Method 2: Check input value
  try {
    const val = await element.inputValue();
    if (val && val.trim() !== '' && val !== 'Select...' && val !== 'Select') return true;
  } catch { /* not an input */ }

  // Method 3: Check aria-expanded
  try {
    const expanded = await element.getAttribute('aria-expanded');
    const hasDescendant = await element.getAttribute('aria-activedescendant');
    if (expanded === 'false' && hasDescendant) return true;
  } catch {}

  return false;
}
