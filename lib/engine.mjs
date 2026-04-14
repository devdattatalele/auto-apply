/**
 * engine.mjs — Core fill engine
 *
 * Fills application forms using a plan JSON. Handles every field type:
 * text, email, tel, file, checkbox, radio, dropdown, phone-country,
 * typeahead, yes-no-button, multi-select.
 *
 * Includes verification pass and submit retry loop.
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { existsSync } from 'fs';
import { discoverApplicationForm, detectATS } from './discovery.mjs';
import { findField, handleDropdown, verifyDropdownFilled, fuzzyScore } from './fields.mjs';
import { handlePostSubmitOTP } from './otp.mjs';
import { takeScreenshot, logToCSV } from './reporter.mjs';
import { recordResult } from './learner.mjs';
import { isSubmitButton } from './scanner.mjs';
import { handleWorkday } from './workday.mjs';

// ─── Submit button finder ───────────────────────────────────────────────────
async function clickSubmitButton(page) {
  const submitSelectors = [
    'button:has-text("Submit application")',
    'button:has-text("Submit Application")',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply Now")',
    'button:has-text("Send Application")',
    'button:has-text("Complete Application")',
    'a:has-text("Submit Application")',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        const text = await btn.textContent().catch(() => '');
        console.log(`  🚀 Clicking Submit: "${text.trim()}"...`);
        await btn.click();
        await page.waitForTimeout(3000);
        return true;
      }
    } catch { /* try next */ }
  }
  console.log('  ⚠️  No Submit button found.');
  return false;
}

// ─── Yes/No button handler ──────────────────────────────────────────────────
async function handleYesNoButton(page, entry, value) {
  const labelText = entry.label || '';
  const targetValue = value;

  // Strategy 1: DOM traversal from label to sibling buttons
  let clicked = await page.evaluate(({ labelText, targetValue }) => {
    const labels = Array.from(document.querySelectorAll('label'));
    let targetLabel = labels.find(l => l.textContent.trim().startsWith(labelText.substring(0, 40)));
    if (!targetLabel) {
      const allEls = document.querySelectorAll('div, span, p, h3, h4');
      targetLabel = Array.from(allEls).find(el =>
        el.textContent.includes(labelText.substring(0, 40)) &&
        el.textContent.length < labelText.length + 50
      );
    }
    if (!targetLabel) return false;
    const container = targetLabel.closest('[class*="field"], [class*="question"], [class*="Field"], [class*="Question"]') || targetLabel.parentElement;
    if (!container) return false;
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === targetValue) { btn.click(); return true; }
    }
    return false;
  }, { labelText, targetValue });

  if (!clicked) {
    // Strategy 2: Playwright text selector with label proximity
    const btns = await page.$$(`button:has-text("${targetValue}")`);
    for (const btn of btns) {
      const parentText = await btn.evaluate(el => {
        const p = el.closest('[class*="field"], [class*="question"], [class*="Field"]') || el.parentElement?.parentElement;
        return p ? p.textContent : '';
      });
      if (parentText.includes(labelText.substring(0, 30))) {
        await btn.click();
        clicked = true;
        break;
      }
    }
  }

  return clicked;
}

// ─── Typeahead handler ──────────────────────────────────────────────────────
async function handleTypeahead(page, el, value, fieldName) {
  await el.click();
  await page.waitForTimeout(200);
  await el.fill('');
  await page.waitForTimeout(100);
  await el.type(value, { delay: 80 });
  await page.waitForTimeout(1500);

  const optionSelectors = [
    '[role="option"]', '[class*="option"]', '[class*="suggestion"]',
    '[class*="result"]', 'li[class*="item"]', '[class*="autocomplete"] li',
    '[class*="dropdown"] li', '[class*="listbox"] [role="option"]',
  ];

  for (const sel of optionSelectors) {
    const options = await page.$$(sel);
    if (options.length > 0) {
      await options[0].click();
      console.log(`  ✅ Typeahead: ${fieldName} ← "${value}" (picked suggestion)`);
      return true;
    }
  }

  console.log(`  ✅ Typeahead (typed): ${fieldName} ← "${value}"`);
  return true;
}

// ─── Multi-select handler ───────────────────────────────────────────────────
async function handleMultiSelect(page, el, values, fieldName) {
  let selectedCount = 0;
  for (const val of values) {
    try {
      await el.click();
      await page.waitForTimeout(300);
      await el.evaluate(e => { e.value = ''; });
      await page.waitForTimeout(100);
      await el.type(val.substring(0, 15), { delay: 80 });
      await page.waitForTimeout(800);

      const optionSelectors = ['.select__option', '[role="option"]', '[class*="option"]'];
      let picked = false;

      for (const optSel of optionSelectors) {
        const options = await page.$$(optSel);
        for (const opt of options) {
          const isVisible = await opt.isVisible().catch(() => false);
          if (!isVisible) continue;
          const text = (await opt.textContent().catch(() => '')).trim();
          if (!text || text === 'No options' || text.length > 100) continue;
          if (text.toLowerCase() === val.toLowerCase() || fuzzyScore(val, text) >= 0.5) {
            await opt.click();
            picked = true;
            selectedCount++;
            console.log(`  ✅ Multi-select: ${fieldName} += "${val}"`);
            break;
          }
        }
        if (picked) break;
      }

      if (!picked) console.log(`  ⚠️  Multi-select option not found: "${val}"`);
      await page.waitForTimeout(400);
    } catch (err) {
      console.log(`  ⚠️  Multi-select error for "${val}": ${err.message}`);
    }
  }

  if (selectedCount > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  return selectedCount > 0;
}

// ─── Main fill function ─────────────────────────────────────────────────────
export async function fillForm(url, plan, { otpEmail, otpPassword, workdayEmail, workdayPassword } = {}) {
  console.log(`📝 Fill mode: ${url}`);
  if (otpEmail) console.log(`📧 OTP auto-fetch: ${otpEmail}`);

  const ats = detectATS(url);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const fieldResults = []; // for learner

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* partial load OK */ }
    await page.waitForTimeout(2000);

    // Handle Workday login/account creation if needed
    if (ats === 'workday') {
      const wdOk = await handleWorkday(page, {
        email: workdayEmail || otpEmail,
        password: workdayPassword,
        otpEmail,
        otpPassword,
      });
      if (!wdOk) {
        console.log('  ⚠️  Workday login failed — attempting to fill anyway...');
      }
      await page.waitForTimeout(2000);
    }

    await discoverApplicationForm(page, url);

    const fills = plan.fills || plan.fields || [];
    let filled = 0, skipped = 0, errors = 0;

    for (const entry of fills) {
      const { value, type, label } = entry;
      if (value === undefined || value === null || value === '') {
        skipped++;
        continue;
      }

      const fieldName = label || entry.id || entry.selector || 'unknown';

      try {
        // ─── Types that locate elements themselves ──────────────────
        if (type === 'yes-no-button') {
          const clicked = await handleYesNoButton(page, entry, value);
          if (clicked) {
            console.log(`  ✅ Button: ${fieldName} ← "${value}"`);
            filled++;
            fieldResults.push({ field: fieldName, type, status: 'ok' });
          } else {
            console.log(`  ❌ Yes/No button not found: ${fieldName}`);
            errors++;
            fieldResults.push({ field: fieldName, type, status: 'not-found' });
          }
          await page.waitForTimeout(300 + Math.random() * 400);
          continue;
        }

        if (type === 'multi-select' && Array.isArray(value)) {
          const el = await findField(page, entry);
          if (!el) { errors++; continue; }
          await el.scrollIntoViewIfNeeded().catch(() => {});
          const ok = await handleMultiSelect(page, el, value, fieldName);
          if (ok) filled++; else errors++;
          await page.waitForTimeout(300 + Math.random() * 400);
          continue;
        }

        // ─── Find the element ───────────────────────────────────────
        const el = await findField(page, entry);
        if (!el) {
          // Checkbox fallback: find by label text
          if (type === 'checkbox') {
            const checkboxLabel = entry.label || entry.name || '';
            const cb = await page.$(`label:has-text("${checkboxLabel}") input[type="checkbox"]`);
            if (cb) {
              const isChecked = await cb.isChecked().catch(() => false);
              if (!isChecked && (value === true || value === 'true' || value === 'yes')) {
                await cb.click();
                console.log(`  ☑️  Checked (label): ${fieldName}`);
                filled++;
              }
              await page.waitForTimeout(300 + Math.random() * 400);
              continue;
            }
            const labelEl = await page.$(`label:has-text("${checkboxLabel}")`);
            if (labelEl) {
              await labelEl.click();
              console.log(`  ☑️  Checked (click label): ${fieldName}`);
              filled++;
              await page.waitForTimeout(300 + Math.random() * 400);
              continue;
            }
          }
          console.log(`  ❌ Not found: ${fieldName}`);
          errors++;
          fieldResults.push({ field: fieldName, type, status: 'not-found' });
          continue;
        }

        await el.scrollIntoViewIfNeeded().catch(() => {});

        // ─── Route to the right handler ─────────────────────────────
        if (type === 'file') {
          const filePath = resolve(process.cwd(), value);
          if (!existsSync(filePath)) {
            console.log(`  ❌ File not found: ${value}`);
            errors++;
            continue;
          }
          await el.setInputFiles(filePath);
          console.log(`  📎 Uploaded: ${fieldName} ← ${basename(value)}`);
          filled++;

        } else if (type === 'checkbox') {
          if (value === true || value === 'true' || value === 'yes') {
            const isChecked = await el.isChecked().catch(() => false);
            if (!isChecked) { await el.click(); console.log(`  ☑️  Checked: ${fieldName}`); filled++; }
          } else { skipped++; }

        } else if (type === 'radio') {
          try {
            await page.click(`input[name="${entry.name}"][value="${value}"]`);
            console.log(`  ✅ Radio: ${fieldName} ← "${value}"`);
            filled++;
          } catch {
            try {
              await page.click(`label:has-text("${value}")`);
              console.log(`  ✅ Radio (label): ${fieldName} ← "${value}"`);
              filled++;
            } catch { console.log(`  ❌ Radio failed: ${fieldName}`); errors++; }
          }

        } else if (type === 'phone-country') {
          try {
            await el.click();
            await page.waitForTimeout(500);
            const searchInput = await page.$('.iti__search-input, input[role="combobox"][aria-label="Search"]');
            if (searchInput) { await searchInput.fill(value); await page.waitForTimeout(500); }
            const countryOpt = await page.$(`li[role="option"] .iti__country-name:has-text("${value}")`);
            if (countryOpt) {
              const li = await countryOpt.evaluateHandle(el => el.closest('li'));
              await li.click();
              console.log(`  ✅ Phone country: ${fieldName} ← "${value}"`);
              filled++;
            } else {
              const firstOpt = await page.$(`li[role="option"]:has-text("${value}")`);
              if (firstOpt) { await firstOpt.click(); filled++; }
              else { console.log(`  ❌ Phone country not found: ${value}`); errors++; }
            }
          } catch (err) { console.log(`  ❌ Phone country error: ${err.message}`); errors++; }

        } else if (type === 'typeahead') {
          try {
            const ok = await handleTypeahead(page, el, value, fieldName);
            if (ok) filled++; else errors++;
          } catch (err) { console.log(`  ❌ Typeahead error: ${fieldName} — ${err.message}`); errors++; }

        } else if (type === 'select' || type === 'custom-select' || type === 'dropdown') {
          const result = await handleDropdown(page, el, value, label);
          if (result.success) {
            console.log(`  ✅ Dropdown [${result.method}]: ${fieldName} ← "${value}"`);
            filled++;
          } else { console.log(`  ❌ Dropdown failed: ${fieldName}`); errors++; }

        } else {
          // Text / tel / email / textarea — check if secretly a dropdown
          const isReadonly = await el.evaluate(e => e.readOnly || e.getAttribute('aria-haspopup') || e.getAttribute('role') === 'combobox').catch(() => false);
          const couldBeDropdown = isReadonly || ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => (fieldName + entry.id).toLowerCase().includes(k));

          if (couldBeDropdown) {
            const result = await handleDropdown(page, el, value, label);
            if (result.success) {
              console.log(`  ✅ Auto-dropdown [${result.method}]: ${fieldName} ← "${value}"`);
              filled++;
            } else {
              try {
                await el.click({ clickCount: 3 }); await el.fill(value);
                console.log(`  ✅ Filled (fallback): ${fieldName} ← "${value.length > 50 ? value.substring(0, 50) + '...' : value}"`);
                filled++;
              } catch { console.log(`  ❌ Failed: ${fieldName}`); errors++; }
            }
          } else {
            try {
              await el.click(); await page.waitForTimeout(100); await el.fill(value);
              const display = value.length > 60 ? value.substring(0, 60) + '...' : value;
              console.log(`  ✅ Filled: ${fieldName} ← "${display}"`);
              filled++;
            } catch {
              try {
                await el.click({ clickCount: 3 }); await el.type(value, { delay: 30 });
                console.log(`  ✅ Typed: ${fieldName} ← "${value.length > 50 ? value.substring(0, 50) + '...' : value}"`);
                filled++;
              } catch (err) { console.log(`  ❌ Failed: ${fieldName} — ${err.message}`); errors++; }
            }
          }
        }

        await page.waitForTimeout(300 + Math.random() * 400);
        fieldResults.push({ field: fieldName, type, status: 'ok' });

      } catch (err) {
        console.log(`  ❌ Error on ${fieldName}: ${err.message}`);
        errors++;
        fieldResults.push({ field: fieldName, type, status: 'error', error: err.message });
      }
    }

    // ─── Dynamic fields ─────────────────────────────────────────────
    const dynamicFills = plan.dynamic_fills || [];
    if (dynamicFills.length > 0) {
      console.log(`\n  🔄 Filling ${dynamicFills.length} dynamic field(s)...`);
      await page.waitForTimeout(1500);
      for (const entry of dynamicFills) {
        const el = await findField(page, entry);
        if (el) {
          const result = await handleDropdown(page, el, entry.value, entry.label);
          if (result.success) {
            console.log(`  ✅ Dynamic [${result.method}]: ${entry.label} ← "${entry.value}"`);
            filled++;
          } else { console.log(`  ❌ Dynamic failed: ${entry.label}`); errors++; }
        }
        await page.waitForTimeout(500);
      }
    }

    // ─── VERIFICATION PASS ──────────────────────────────────────────
    console.log(`\n🔍 Verification pass — checking all fields...`);
    await page.waitForTimeout(1000);
    const allEntries = [...fills.filter(e => e.value), ...dynamicFills];
    let verifyFails = [];

    for (const entry of allEntries) {
      if (entry.type === 'file' || entry.type === 'yes-no-button' || entry.type === 'checkbox') continue;
      const el = await findField(page, entry);
      if (!el) continue;

      const fieldName = entry.label || entry.id || 'unknown';
      const isDropdownType = entry.type === 'dropdown' || entry.type === 'select' || entry.type === 'custom-select' ||
        ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => (fieldName + (entry.id || '')).toLowerCase().includes(k));

      let hasValue = false;
      if (isDropdownType) {
        hasValue = await verifyDropdownFilled(page, el, entry.value);
      } else {
        const currentVal = await el.inputValue().catch(() => '');
        hasValue = currentVal && currentVal.trim() !== '' && currentVal !== 'Select...' && currentVal !== 'Select';
      }

      if (!hasValue) {
        console.log(`  ⚠️  EMPTY: ${fieldName} — will retry`);
        verifyFails.push(entry);
      } else {
        console.log(`  ✓ OK: ${fieldName}`);
      }
    }

    // ─── RETRY failed fields ────────────────────────────────────────
    if (verifyFails.length > 0) {
      console.log(`\n🔄 Retrying ${verifyFails.length} unfilled field(s)...`);
      for (let retry = 1; retry <= 3; retry++) {
        if (verifyFails.length === 0) break;
        console.log(`\n  ── Retry pass ${retry}/3 ──`);
        await page.waitForTimeout(1000);

        const stillFailing = [];
        for (const entry of verifyFails) {
          const el = await findField(page, entry);
          if (!el) { stillFailing.push(entry); continue; }
          await el.scrollIntoViewIfNeeded().catch(() => {});

          const isDropdown = entry.type === 'dropdown' || entry.type === 'select' || entry.type === 'custom-select' ||
            ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => ((entry.label || '') + (entry.id || '')).toLowerCase().includes(k));

          let result;
          if (isDropdown) {
            await page.keyboard.press('Escape'); await page.waitForTimeout(300);
            result = await handleDropdown(page, el, entry.value, entry.label);
          } else {
            try {
              await el.click({ clickCount: 3 }); await page.waitForTimeout(100);
              await el.fill(entry.value);
              result = { success: true, method: 'retry-fill' };
            } catch { result = { success: false }; }
          }

          if (result.success) {
            await page.waitForTimeout(500);
            const verified = await verifyDropdownFilled(page, el, entry.value);
            if (verified) { console.log(`  ✅ Retry OK: ${entry.label}`); }
            else { stillFailing.push(entry); }
          } else { stillFailing.push(entry); }
          await page.waitForTimeout(500);
        }
        verifyFails = stillFailing;
      }

      if (verifyFails.length > 0) {
        console.log(`\n  ⚠️  ${verifyFails.length} field(s) could not be filled after retries:`);
        verifyFails.forEach(e => console.log(`    - ${e.label || e.id}`));
      }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`✅ Fill + verify complete: ${filled} filled, ${skipped} skipped, ${errors} errors`);

    await takeScreenshot(page, 'pre-submit');

    // ─── WORKDAY NEXT BUTTON (multi-step wizard) ──────────────────────
    if (ats === 'workday') {
      const nextBtn = await page.$('button:has-text("Next"), a:has-text("Next"), button[data-automation-id="bottom-navigation-next-button"]');
      if (nextBtn) {
        const visible = await nextBtn.isVisible().catch(() => false);
        if (visible) {
          console.log('\n  ➡️  Workday wizard: clicking Next...');
          await nextBtn.click();
          await page.waitForTimeout(3000);
          try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
          console.log('  📄 Moved to next page. Additional pages may need manual completion.');
          await takeScreenshot(page, 'workday-next-page');
        }
      }
    }

    // ─── SUBMIT + ERROR RETRY LOOP ──────────────────────────────────
    let status = 'filled-not-submitted';
    for (let submitAttempt = 1; submitAttempt <= 3; submitAttempt++) {
      console.log(`\n🚀 Submit attempt ${submitAttempt}/3...`);
      const submitted = await clickSubmitButton(page);
      if (!submitted) { status = 'no-submit-button'; break; }

      await page.waitForTimeout(3000);

      const errorMessages = await page.evaluate(() => {
        const errs = [];
        document.querySelectorAll('.error, .field-error, .error-message, .invalid-feedback, [class*="error"], [class*="Error"], [role="alert"], .field--error, .has-error, .form-error').forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 200 && text.length > 2) errs.push(text);
        });
        return [...new Set(errs)];
      });

      if (errorMessages.length === 0) {
        const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (/verification\s*code|enter.*code|confirm.*human|code\s*was\s*sent/i.test(bodyText)) {
          if (otpEmail && otpPassword) {
            const submitTime = Date.now() - 10000;
            status = await handlePostSubmitOTP(page, otpEmail, otpPassword, submitTime);
          } else { status = 'needs-otp'; }
        } else { status = 'submitted'; }
        break;
      }

      console.log(`  ❌ ${errorMessages.length} validation error(s):`);
      errorMessages.forEach(e => console.log(`    • ${e}`));
      await takeScreenshot(page, `submit-error-${submitAttempt}`);

      // Detect newly-revealed required fields (Workday conditional selects)
      const newSelects = await page.$$('select');
      for (const sel of newSelects) {
        const selId = await sel.getAttribute('id').catch(() => '');
        const isAlreadyFilled = await sel.evaluate(e => e.value && e.value !== '').catch(() => false);
        if (!isAlreadyFilled && selId) {
          const labelEl = await page.$(`label[for="${selId}"]`);
          const labelText = labelEl ? (await labelEl.textContent().catch(() => '')).replace(/\*+/g, '').trim() : '';
          if (labelText && /source/i.test(labelText)) {
            console.log(`  🔧 Filling conditional select: ${labelText}...`);
            try {
              await sel.selectOption({ label: 'LinkedIn' });
              console.log(`  ✅ Conditional select: ${labelText} ← "LinkedIn"`);
            } catch {
              // Try first non-empty option
              const opts = await sel.evaluate(e => Array.from(e.options).filter(o => o.value).map(o => ({ v: o.value, t: o.text })));
              if (opts.length > 0) {
                await sel.selectOption({ value: opts[0].v });
                console.log(`  ✅ Conditional select: ${labelText} ← "${opts[0].t}"`);
              }
            }
          }
        }
      }

      // Re-fill empty fields from plan
      for (const entry of [...fills.filter(e => e.value), ...dynamicFills]) {
        if (entry.type === 'file') continue;
        const el = await findField(page, entry);
        if (!el) continue;
        const isDD = ['dropdown', 'select', 'custom-select'].includes(entry.type) ||
          ['country', 'gender', 'veteran', 'disability', 'ethnicity', 'race', 'hispanic'].some(k => ((entry.label || '') + (entry.id || '')).toLowerCase().includes(k));
        if (isDD) { if (await verifyDropdownFilled(page, el, entry.value)) continue; }
        else { const v = await el.inputValue().catch(() => ''); if (v && v.trim() !== '' && v !== 'Select...') continue; }

        console.log(`  🔧 Re-filling: ${entry.label || entry.id}...`);
        if (isDD) {
          await page.keyboard.press('Escape'); await page.waitForTimeout(300);
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await handleDropdown(page, el, entry.value, entry.label);
        } else {
          try { await el.click({ clickCount: 3 }); await el.fill(entry.value); } catch {}
        }
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1000);
    }

    const postSubmitSS = await takeScreenshot(page, 'post-submit');
    await logToCSV(url, plan.company || '', plan.role || '', status, postSubmitSS, { ats });

    // Record for learner
    try {
      await recordResult(url, plan, status, fieldResults);
    } catch { /* non-critical */ }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🏁 Result: ${status}`);
    console.log(`   Screenshots: screenshots/`);
    console.log(`   Report: data/applied.csv`);
    console.log(`${'─'.repeat(60)}`);

    console.log(`\n   Browser stays open for 15s — Ctrl+C to keep it open longer.`);
    await page.waitForTimeout(15000);
    await browser.close();
    return status;

  } catch (err) {
    console.error(`❌ Fill failed: ${err.message}`);
    await browser.close();
    throw err;
  }
}
