/**
 * scanner.mjs — Form field scanner
 *
 * Navigates to a job URL, discovers the application form,
 * extracts all fields (inputs, selects, textareas, custom dropdowns),
 * and writes a scan JSON.
 */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { discoverApplicationForm } from './discovery.mjs';

// ─── Submit button patterns ────────────────────────────────────────────────
const SUBMIT_PATTERNS = [
  /submit\s*application/i,
  /submit/i,
  /send\s*application/i,
  /apply\s*now/i,
  /complete\s*application/i,
];

export function isSubmitButton(text) {
  return SUBMIT_PATTERNS.some(p => p.test(text.trim()));
}

// ─── Slug helper ────────────────────────────────────────────────────────────
export function slugify(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname.replace(/^(boards|job-boards|jobs|careers)\./, '').replace(/\..+$/, '');

    // Skip generic path segments that don't identify the job
    const skipParts = new Set(['jobs', 'embed', 'job_app', 'us', 'en', 'apply', 'job', 'careers', 'career', 'position', 'posting']);
    const isJobId = (p) => /^\d+$/.test(p) || /^[A-Z]\d{4,}/.test(p) || /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}/.test(p);
    const jobId = parts.find(p => isJobId(p)) || parts[parts.length - 1] || u.searchParams.get('token') || '';
    const company = parts.find(p => !skipParts.has(p.toLowerCase()) && !isJobId(p)) || host;

    const slug = `${company}-${jobId}`.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase();
    return slug === '-' ? host : slug;
  } catch {
    return 'unknown-form';
  }
}

// ─── Scan a form ────────────────────────────────────────────────────────────
export async function scanForm(url, { formsDir, browser: existingBrowser } = {}) {
  console.log(`🔍 Scanning: ${url}`);
  const outDir = formsDir || resolve(process.cwd(), 'forms');
  await mkdir(outDir, { recursive: true });

  const ownBrowser = !existingBrowser;
  const browser = existingBrowser || await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait extra for JS-heavy pages (Workday, custom portals)
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* partial load OK */ }
    await page.waitForTimeout(2000);

    let formUrl = url;
    const foundForm = await discoverApplicationForm(page, url);
    if (foundForm) formUrl = foundForm;

    const pageTitle = await page.title();

    // Extract all form fields
    const fields = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      function getLabel(el) {
        if (el.id) {
          const label = document.querySelector(`label[for="${el.id}"]`);
          if (label) return label.textContent.trim();
        }
        const parentLabel = el.closest('label');
        if (parentLabel) return parentLabel.textContent.trim();
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const refEl = document.getElementById(labelledBy);
          if (refEl) return refEl.textContent.trim();
        }
        if (el.placeholder) return el.placeholder;
        const prev = el.previousElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
          return prev.textContent.trim();
        }
        const parent = el.parentElement;
        if (parent) {
          const textNode = Array.from(parent.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
          if (textNode) return textNode.textContent.trim();
        }
        return el.name || el.id || '';
      }

      function getRequired(el) {
        return el.required || el.getAttribute('aria-required') === 'true' ||
               (el.closest('.field') && el.closest('.field').querySelector('.required, .asterisk, [aria-required]') !== null);
      }

      document.querySelectorAll('input, textarea, select').forEach(el => {
        const type = el.type || el.tagName.toLowerCase();
        if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return;

        const key = el.id || el.name || `${type}-${results.length}`;
        if (seen.has(key)) return;
        seen.add(key);

        const field = {
          id: el.id || el.name || `field_${results.length}`,
          name: el.name || '',
          label: getLabel(el),
          type: type === 'select-one' ? 'select' : type,
          required: getRequired(el),
          selector: '',
          value: el.value || '',
        };

        if (el.id) field.selector = `#${CSS.escape(el.id)}`;
        else if (el.name) field.selector = `${el.tagName.toLowerCase()}[name="${el.name}"]`;
        else field.selector = `${el.tagName.toLowerCase()}:nth-of-type(${results.length + 1})`;

        if (type === 'select-one' || type === 'select') {
          field.options = Array.from(el.options).map(o => ({
            value: o.value, text: o.textContent.trim(),
          })).filter(o => o.value !== '');
        }

        if (type === 'radio') {
          const radios = document.querySelectorAll(`input[name="${el.name}"]`);
          field.options = Array.from(radios).map(r => {
            const lbl = document.querySelector(`label[for="${r.id}"]`);
            return { value: r.value, text: lbl ? lbl.textContent.trim() : r.value };
          });
        }

        if (type === 'file') {
          field.accept = el.getAttribute('accept') || '';
        }

        results.push(field);
      });

      // Detect custom dropdowns
      document.querySelectorAll('[data-field], .field, .application-field').forEach(container => {
        const customSelect = container.querySelector('[role="listbox"], [role="combobox"], .custom-select');
        if (customSelect && !seen.has(customSelect.id)) {
          const label = container.querySelector('label, .field-label, .field__label');
          results.push({
            id: customSelect.id || `custom_${results.length}`,
            name: customSelect.getAttribute('name') || '',
            label: label ? label.textContent.trim() : '',
            type: 'custom-select',
            required: false,
            selector: customSelect.id ? `#${CSS.escape(customSelect.id)}` : `.custom-select:nth-of-type(${results.length + 1})`,
            options: [],
          });
        }
      });

      return results;
    });

    // Detect submit buttons
    const submitButtons = await page.evaluate(() => {
      const buttons = [];
      document.querySelectorAll('button, input[type="submit"], a.btn, [role="button"]').forEach(el => {
        const text = el.textContent.trim() || el.value || '';
        if (text && text.length < 50) {
          buttons.push({ text, type: el.tagName.toLowerCase(), selector: el.id ? `#${el.id}` : '' });
        }
      });
      return buttons;
    });

    // Detect Yes/No button questions (Ashby pattern)
    const buttonQuestions = await page.evaluate(() => {
      const questions = [];
      const labels = document.querySelectorAll('label');
      labels.forEach(label => {
        const container = label.closest('[class*="field"], [class*="question"], [class*="Field"]') || label.parentElement;
        if (!container) return;
        const buttons = container.querySelectorAll('button');
        const btnTexts = Array.from(buttons).map(b => b.textContent.trim());
        if (btnTexts.includes('Yes') && btnTexts.includes('No')) {
          questions.push({
            id: label.htmlFor || `btn_q_${questions.length}`,
            label: label.textContent.trim(),
            type: 'yes-no-button',
            options: ['Yes', 'No'],
          });
        }
      });
      return questions;
    });

    const scan = {
      url: formUrl,
      original_url: url,
      title: pageTitle,
      scanned_at: new Date().toISOString(),
      field_count: fields.length + buttonQuestions.length,
      fields: [...fields, ...buttonQuestions],
      submit_buttons: submitButtons.map(b => ({
        ...b,
        blocked: isSubmitButton(b.text),
      })),
    };

    const slug = slugify(url);
    const outPath = resolve(outDir, `${slug}-scan.json`);
    await writeFile(outPath, JSON.stringify(scan, null, 2));
    console.log(`✅ Scan complete: ${scan.field_count} fields detected`);
    console.log(`📄 Written to: ${outPath}`);
    console.log(`\nField summary:`);
    scan.fields.forEach((f, i) => {
      const req = f.required ? ' *' : '';
      console.log(`  ${i + 1}. [${f.type}] ${f.label || f.id}${req}`);
    });

    await context.close();
    if (ownBrowser) await browser.close();
    return scan;

  } catch (err) {
    console.error(`❌ Scan failed: ${err.message}`);
    await context.close();
    if (ownBrowser) await browser.close();
    throw err;
  }
}
