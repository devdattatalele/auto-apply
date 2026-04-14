/**
 * workday.mjs — Workday account creation & login
 *
 * Workday requires an account to apply. This module:
 * 1. Detects Workday login page
 * 2. Creates account (or logs in if credentials exist)
 * 3. Fills email + auto-generates password
 * 4. Handles email verification for account
 * 5. Navigates to the application form
 */

import { fetchOTPFromGmail } from './otp.mjs';

// ─── Generate a secure password ─────────────────────────────────────────────
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const specials = '!@#$%&*';
  let pwd = '';
  for (let i = 0; i < 12; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  // Add a special char and digit to satisfy most policies
  pwd += specials[Math.floor(Math.random() * specials.length)];
  pwd += Math.floor(Math.random() * 10);
  return pwd;
}

// ─── Detect if page is Workday login ────────────────────────────────────────
export async function isWorkdayLogin(page) {
  const url = page.url();
  if (!/workday|myworkday/i.test(url)) return false;

  const hasLogin = await page.$('input[type="email"], input[data-automation-id="email"], input[data-automation-id="userName"]');
  return !!hasLogin;
}

// ─── Login to Workday ───────────────────────────────────────────────────────
export async function workdayLogin(page, email, password) {
  console.log('  🔑 Logging into Workday...');

  // Find email input
  const emailInput = await page.$('input[type="email"], input[data-automation-id="email"], input[data-automation-id="userName"]');
  if (emailInput) {
    await emailInput.fill(email);
    await page.waitForTimeout(300);
  }

  // Find password input
  const passwordInput = await page.$('input[type="password"], input[data-automation-id="password"]');
  if (passwordInput) {
    await passwordInput.fill(password);
    await page.waitForTimeout(300);
  }

  // Click sign in
  const signInBtn = await page.$('button[data-automation-id="signInSubmitButton"], button:has-text("Sign In"), button[type="submit"]');
  if (signInBtn) {
    await signInBtn.click();
    await page.waitForTimeout(5000);
  }

  // Check if login succeeded
  const stillOnLogin = await page.$('input[type="password"]');
  if (stillOnLogin) {
    console.log('  ❌ Workday login failed — check credentials.');
    return false;
  }

  console.log('  ✅ Workday login successful.');
  return true;
}

// ─── Create Workday account ─────────────────────────────────────────────────
export async function workdayCreateAccount(page, email, otpEmail, otpPassword) {
  console.log('  📝 Creating Workday account...');

  // Click "Create Account" or "New User"
  const createBtn = await page.$([
    'a:has-text("Create Account")',
    'button:has-text("Create Account")',
    'a:has-text("New User")',
    'a:has-text("Sign Up")',
    'button:has-text("Sign Up")',
    'a[data-automation-id="createAccountLink"]',
  ].join(', '));

  if (!createBtn) {
    console.log('  ⚠️  No "Create Account" button found — trying login instead.');
    return null;
  }

  await createBtn.click();
  await page.waitForTimeout(3000);

  // Fill email
  const emailInput = await page.$('input[type="email"], input[data-automation-id="email"], input[name="email"]');
  if (emailInput) {
    await emailInput.fill(email);
    await page.waitForTimeout(300);
  }

  // Generate and fill password
  const password = generatePassword();
  const pwdInputs = await page.$$('input[type="password"]');
  for (const inp of pwdInputs) {
    await inp.fill(password);
    await page.waitForTimeout(200);
  }

  console.log(`  🔐 Generated password: ${password}`);
  console.log('     (Save this — you may need it for future logins at this company)');

  // Accept terms if present
  const termsCheckbox = await page.$('input[type="checkbox"][data-automation-id*="agree"], input[type="checkbox"][name*="agree"], label:has-text("agree") input[type="checkbox"]');
  if (termsCheckbox) {
    const isChecked = await termsCheckbox.isChecked().catch(() => false);
    if (!isChecked) await termsCheckbox.click();
  }

  // Submit account creation
  const submitBtn = await page.$('button[type="submit"], button:has-text("Create"), button:has-text("Submit"), button:has-text("Sign Up")');
  if (submitBtn) {
    await submitBtn.click();
    await page.waitForTimeout(5000);
  }

  // Check for email verification
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/verif|confirm|code|check your email/i.test(bodyText)) {
    console.log('  📧 Email verification required for account...');

    if (otpEmail && otpPassword) {
      const submitTime = Date.now() - 10000;
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const code = await fetchOTPFromGmail(otpEmail, otpPassword, 3, submitTime);
        if (code) {
          console.log(`  🔑 Verification code: ${code}`);
          const codeInput = await page.$('input[name*="code"], input[name*="verification"], input[placeholder*="code"]');
          if (codeInput) {
            await codeInput.fill(code);
            const verifyBtn = await page.$('button:has-text("Verify"), button:has-text("Confirm"), button[type="submit"]');
            if (verifyBtn) { await verifyBtn.click(); await page.waitForTimeout(3000); }
          }
          break;
        }
        console.log(`    ⏳ Waiting for verification email... (${(i + 1) * 5}s)`);
      }
    } else {
      console.log('  ⚠️  No email credentials provided for verification.');
    }
  }

  return password;
}

// ─── Full Workday flow ──────────────────────────────────────────────────────
export async function handleWorkday(page, { email, password, otpEmail, otpPassword }) {
  if (!await isWorkdayLogin(page)) return true; // not a login page

  // Try login first if we have credentials
  if (email && password) {
    const loggedIn = await workdayLogin(page, email, password);
    if (loggedIn) return true;
  }

  // Create account if login failed or no password
  if (email) {
    const newPassword = await workdayCreateAccount(page, email, otpEmail, otpPassword);
    if (newPassword) {
      // Try logging in with the new account
      await page.waitForTimeout(2000);
      return workdayLogin(page, email, newPassword);
    }
  }

  console.log('  ❌ Cannot proceed with Workday — no credentials.');
  return false;
}
