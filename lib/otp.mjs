/**
 * otp.mjs — OTP extraction and entry
 *
 * Handles:
 * - Gmail IMAP OTP fetching (App Password auth)
 * - Verification code extraction from email body
 * - Character-by-character OTP entry (bypasses input handler issues)
 * - Post-submit OTP detection and handling
 */

import { ImapFlow } from 'imapflow';

// ─── OTP extraction patterns ────────────────────────────────────────────────
const OTP_PATTERNS = [
  /verification\s*code\s*(?:is)?[:\s]+([A-Za-z0-9]{6,10})/i,
  /\bcode[:\s]+([A-Za-z0-9]{6,10})\b/i,
  /enter\s*(?:this\s*)?code[:\s]+([A-Za-z0-9]{6,10})/i,
  /\bOTP\s*(?:is)?[:\s]+([A-Za-z0-9]{6,10})/i,
  /^\s*([A-Za-z0-9]{8})\s*$/m,
  /\b(\d{6})\b/,
  /confirm[^.]*?([A-Za-z0-9]{6,10})/i,
];

export function extractOTP(text) {
  for (const pattern of OTP_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

// ─── Fetch OTP from Gmail via IMAP ──────────────────────────────────────────
export async function fetchOTPFromGmail(email, password, maxAgeMinutes = 5, sinceTimestamp = null) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
      const messages = [];
      for await (const msg of client.fetch({ since }, { envelope: true, source: true }, { uid: true })) {
        messages.push(msg);
      }
      messages.sort((a, b) => (b.envelope?.date || 0) - (a.envelope?.date || 0));
      const recent = messages.slice(0, 4);

      for (const msg of recent) {
        if (sinceTimestamp && msg.envelope?.date) {
          const msgTime = new Date(msg.envelope.date).getTime();
          if (msgTime < sinceTimestamp - 120000) continue;
        }
        const source = msg.source?.toString() || '';
        let text = source.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
          .replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        const otp = extractOTP(text);
        if (otp) {
          const from = msg.envelope?.from?.[0]?.address || 'unknown';
          const subject = msg.envelope?.subject || '';
          console.log(`    📬 OTP from: ${from} | ${subject}`);
          return otp;
        }
      }
      return null;
    } finally {
      lock.release();
    }
  } catch (err) {
    console.log(`    ❌ IMAP error: ${err.message}`);
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

// ─── Enter OTP character by character ───────────────────────────────────────
// fill() breaks on many verification fields; type() with delay is reliable.
export async function enterOTP(page, target, code) {
  await target.click();
  await page.waitForTimeout(200);
  await target.press('Control+a').catch(() => target.press('Meta+a').catch(() => {}));
  await target.press('Backspace').catch(() => {});
  await page.waitForTimeout(100);
  await target.type(code, { delay: 100 });
  await page.waitForTimeout(300);
  const entered = await target.inputValue().catch(() => '');
  if (entered !== code) {
    await target.fill(code).catch(() => {});
  }
}

// ─── OTP input skip list ────────────────────────────────────────────────────
// These inputs look like empty text fields but are NOT OTP fields.
async function shouldSkipInput(inp) {
  return inp.evaluate(el => {
    const cls = el.className || '';
    const id = el.id || '';
    const role = el.getAttribute('role') || '';
    const type = el.type || '';
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (type === 'search' || type === 'tel') return true;
    if (role === 'combobox') return true;
    if (cls.includes('search') || cls.includes('select__input') || cls.includes('iti__')) return true;
    if (id.includes('search') || id.includes('phone') || id.includes('country')) return true;
    if (ariaLabel.includes('search') || ariaLabel.includes('phone')) return true;
    return false;
  }).catch(() => false);
}

// ─── Handle OTP verification after submit ───────────────────────────────────
export async function handlePostSubmitOTP(page, email, password, submitTimestamp) {
  await page.waitForTimeout(2000);

  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

  const verificationPatterns = [
    /verification\s*code/i,
    /enter\s*(the\s*)?code/i,
    /confirm\s*you.*human/i,
    /\d[\s-]character\s*code/i,
    /code\s*was\s*sent/i,
    /sent.*code/i,
  ];

  const hasPrompt = verificationPatterns.some(p => p.test(bodyText));
  if (!hasPrompt) {
    console.log('  ✅ No OTP verification needed — application may be submitted.');
    return 'submitted';
  }

  console.log('  🔔 OTP verification detected! Fetching from email...');

  // Poll for OTP for up to 90 seconds
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const otp = await fetchOTPFromGmail(email, password, 3, submitTimestamp);
    if (!otp) {
      console.log(`    ⏳ Waiting for OTP... (${(i + 1) * 5}s)`);
      continue;
    }

    console.log(`  🔑 OTP: ${otp}`);

    // Find the verification input by name/attribute
    const codeSelectors = [
      'input[name*="verification"]', 'input[name*="code"]',
      'input[placeholder*="code"]', 'input[placeholder*="verification"]',
      'input[aria-label*="verification"]', 'input[aria-label*="code"]',
      'input[id*="verification"]', 'input[id*="code"]',
    ];

    for (const sel of codeSelectors) {
      const input = await page.$(sel);
      if (input && await input.isVisible().catch(() => false)) {
        await enterOTP(page, input, otp);
        console.log('  ✅ OTP entered.');
        await page.waitForTimeout(500);
        const confirmBtn = await page.$('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit"), button[type="submit"]');
        if (confirmBtn) {
          const cText = await confirmBtn.textContent().catch(() => '');
          console.log(`  🚀 Clicking: "${cText.trim()}"...`);
          await confirmBtn.click();
          await page.waitForTimeout(3000);
        }
        return 'submitted-with-otp';
      }
    }

    // Fallback: find any empty visible text input (skip phone/search/autocomplete)
    const inputs = await page.$$('input[type="text"], input:not([type])');
    for (const inp of inputs) {
      const val = await inp.inputValue().catch(() => 'x');
      const vis = await inp.isVisible().catch(() => false);
      if (!vis || val) continue;
      if (await shouldSkipInput(inp)) continue;

      await enterOTP(page, inp, otp);
      console.log('  ✅ OTP entered (fallback).');
      const confirmBtn = await page.$('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit"), button[type="submit"]');
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }
      return 'submitted-with-otp';
    }

    console.log(`  ⚠️  OTP found (${otp}) but no input field detected.`);
    return 'otp-found-no-input';
  }

  console.log('  ❌ Timed out waiting for OTP.');
  return 'otp-timeout';
}
