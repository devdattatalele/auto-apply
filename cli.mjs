#!/usr/bin/env node

/**
 * auto-apply — Autonomous job application engine
 *
 * Commands:
 *   setup                    Interactive onboarding (creates profile.yml)
 *   scan  <url>              Scan form fields → forms/{slug}-scan.json
 *   fill  <url> [plan.json]  Fill form (auto-generates plan if no plan given)
 *   apply <url>              Full pipeline: scan → plan → fill → submit → OTP
 *   batch [targets.txt]      Apply to all URLs in file (or process queue)
 *   queue add <url> [company] Add URL to application queue
 *   queue list               Show pending/applied/failed queue entries
 *   queue remove <url>       Remove URL from queue
 *   status                   Show application stats
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { scanForm, slugify } from './lib/scanner.mjs';
import { fillForm } from './lib/engine.mjs';
import { loadProfile, generatePlan, pickResume } from './lib/planner.mjs';
import { applyLearnings, getStats } from './lib/learner.mjs';
import { extractJDText, detectATS } from './lib/discovery.mjs';
import { loadQueue, saveQueue, addToQueue, getPendingFromQueue } from './lib/reporter.mjs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse CLI args ─────────────────────────────────────────────────────────
const [,, command, ...rawArgs] = process.argv;

let otpEmail = process.env.EMAIL || '';
let otpPassword = process.env.APP_PASSWORD || '';
let workdayEmail = process.env.WORKDAY_EMAIL || '';
let workdayPassword = process.env.WORKDAY_PASSWORD || '';
const positionalArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--otp-email' && rawArgs[i + 1]) otpEmail = rawArgs[++i];
  else if (rawArgs[i] === '--otp-password' && rawArgs[i + 1]) otpPassword = rawArgs[++i];
  else positionalArgs.push(rawArgs[i]);
}

// ─── Load .env if present ───────────────────────────────────────────────────
async function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const content = await readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) {
        const [, key, val] = match;
        if (key === 'EMAIL' && !otpEmail) otpEmail = val.trim();
        if (key === 'APP_PASSWORD' && !otpPassword) otpPassword = val.trim();
        if (key === 'WORKDAY_EMAIL' && !workdayEmail) workdayEmail = val.trim();
        if (key === 'WORKDAY_PASSWORD' && !workdayPassword) workdayPassword = val.trim();
      }
    }
  }
}

// ─── SETUP ──────────────────────────────────────────────────────────────────
async function cmdSetup() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║          auto-apply — Setup Wizard                    ║
╚════════════════════════════════════════════════════════╝

This wizard creates your config/profile.yml.
You can also create it manually — see config/profile.example.yml.
`);

  const profilePath = resolve(process.cwd(), 'config', 'profile.yml');
  if (existsSync(profilePath)) {
    console.log('✅ config/profile.yml already exists.');
    console.log('   Edit it directly or delete it to re-run setup.');
    return;
  }

  console.log('Create config/profile.yml with your details.');
  console.log('Use config/profile.example.yml as a template.\n');

  // Look for example in cwd first, then in package directory (for npx)
  const examplePath = resolve(process.cwd(), 'config', 'profile.example.yml');
  const pkgExamplePath = resolve(__dirname, 'config', 'profile.example.yml');
  const foundExample = existsSync(examplePath) ? examplePath : existsSync(pkgExamplePath) ? pkgExamplePath : null;

  if (foundExample) {
    const example = await readFile(foundExample, 'utf-8');
    await mkdir(resolve(process.cwd(), 'config'), { recursive: true });
    await writeFile(profilePath, example);
    console.log('📄 Copied profile.example.yml → profile.yml');
    console.log('   Edit config/profile.yml with your details, then run:');
    console.log('   auto-apply apply <job-url>\n');
  } else {
    console.log('No profile.example.yml found. Creating a blank profile...');
    const blank = `# Auto-apply profile
personal:
  first_name: ""
  last_name: ""
  email: ""
  phone: ""
  linkedin: ""
  location: ""
  country: "United States +1"

eeo:
  gender: ""
  hispanic_latino: "No"
  race: ""
  veteran_status: "I am not a protected veteran"
  disability_status: "I do not want to answer"

work_auth:
  authorized_us: "Yes"
  sponsorship_needed: "No"
  office_willing: "Yes"

education:
  degree: ""
  major: ""
  university: ""
  graduation_year: ""

experience:
  years: ""
  current_company: ""
  current_title: ""
`;
    await mkdir(resolve(process.cwd(), 'config'), { recursive: true });
    await writeFile(profilePath, blank);
    console.log('📄 Created blank config/profile.yml — fill in your details.');
  }

  // Copy resumes.example.yml if missing
  const resumesPath = resolve(process.cwd(), 'config', 'resumes.yml');
  if (!existsSync(resumesPath)) {
    const resumeExample = resolve(__dirname, 'config', 'resumes.example.yml');
    const resumeLocal = resolve(process.cwd(), 'config', 'resumes.example.yml');
    const src = existsSync(resumeLocal) ? resumeLocal : existsSync(resumeExample) ? resumeExample : null;
    if (src) {
      await writeFile(resumesPath, await readFile(src, 'utf-8'));
      console.log('📄 Copied resumes.example.yml → resumes.yml');
    }
  }

  // Copy .env.example if no .env
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    const envExample = resolve(__dirname, '.env.example');
    const envLocal = resolve(process.cwd(), '.env.example');
    const src = existsSync(envLocal) ? envLocal : existsSync(envExample) ? envExample : null;
    if (src) {
      await writeFile(envPath, await readFile(src, 'utf-8'));
      console.log('📄 Copied .env.example → .env (edit with your Gmail App Password for OTP)');
    }
  }

  // Create directories
  await mkdir(resolve(process.cwd(), 'resumes'), { recursive: true });
  await mkdir(resolve(process.cwd(), 'forms'), { recursive: true });
  await mkdir(resolve(process.cwd(), 'screenshots'), { recursive: true });
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });

  console.log(`
✅ Setup complete! Next steps:

  1. Edit config/profile.yml with your details
  2. Edit config/resumes.yml and add your PDF to resumes/
  3. Edit .env with your Gmail App Password (for OTP)
  4. Run: auto-apply apply <job-url>

Or add URLs to queue:
  auto-apply queue add <url> <company>
  auto-apply batch
`);
}

// ─── SCAN ───────────────────────────────────────────────────────────────────
async function cmdScan(url) {
  if (!url) {
    console.log('Usage: node cli.mjs scan <url>');
    process.exit(1);
  }
  await scanForm(url);
}

// ─── FILL ───────────────────────────────────────────────────────────────────
async function cmdFill(url, planPath) {
  if (!url) {
    console.log('Usage: node cli.mjs fill <url> [plan.json]');
    process.exit(1);
  }

  let plan;
  if (planPath) {
    // Use provided plan
    const raw = await readFile(planPath, 'utf-8');
    plan = JSON.parse(raw);
    console.log(`📋 Plan: ${planPath}`);
  } else {
    // Auto-generate plan
    console.log('📋 Auto-generating fill plan from profile...');
    const profile = await loadProfile();
    const scan = await scanForm(url);
    const resumePath = await pickResume('', resolve(process.cwd(), 'config', 'resumes.yml')).catch(() => null);
    plan = await generatePlan(scan, profile, { resumePath, url });

    // Save generated plan
    const slug = slugify(url);
    const planOutPath = resolve(process.cwd(), 'forms', `${slug}-plan.json`);
    await writeFile(planOutPath, JSON.stringify(plan, null, 2));
    console.log(`📄 Auto-plan saved: ${planOutPath}`);

    if (plan.unmapped?.length > 0) {
      console.log(`\n⚠️  ${plan.unmapped.length} unmapped field(s) — may need manual values:`);
      plan.unmapped.forEach(f => console.log(`    - ${f.label} [${f.type}]`));
    }
  }

  // Apply learnings from past runs
  plan = await applyLearnings(plan, url);

  await fillForm(url, plan, { otpEmail, otpPassword, workdayEmail, workdayPassword });
}

// ─── APPLY (full pipeline) ──────────────────────────────────────────────────
async function cmdApply(url) {
  if (!url) {
    console.log('Usage: node cli.mjs apply <url>');
    process.exit(1);
  }

  const profilePath = resolve(process.cwd(), 'config', 'profile.yml');
  if (!existsSync(profilePath)) {
    console.log('❌ No config/profile.yml found. Run: node cli.mjs setup');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 AUTO-APPLY: ${url}`);
  console.log(`${'═'.repeat(60)}\n`);

  const ats = detectATS(url);
  console.log(`🔍 ATS detected: ${ats}`);

  // Step 1: Scan
  console.log('\n── Step 1: Scan form ──');
  const scan = await scanForm(url);

  // Step 2: Load profile & pick resume
  console.log('\n── Step 2: Load profile & pick resume ──');
  const profile = await loadProfile();

  // Extract JD text for resume matching
  let jdText = '';
  try {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    jdText = await extractJDText(page);
    await browser.close();
  } catch { /* couldn't extract JD */ }

  const resumesYml = resolve(process.cwd(), 'config', 'resumes.yml');
  let resumePath = null;
  if (existsSync(resumesYml)) {
    resumePath = await pickResume(jdText, resumesYml);
  }

  // Step 3: Generate plan
  console.log('\n── Step 3: Generate fill plan ──');
  let plan = await generatePlan(scan, profile, { resumePath, jdText, url });

  // Save plan
  const slug = slugify(url);
  const planPath = resolve(process.cwd(), 'forms', `${slug}-plan.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2));
  console.log(`📄 Plan: ${planPath}`);
  console.log(`📋 ${plan.fills.length} fills, ${plan.skipped.length} skipped, ${plan.unmapped?.length || 0} unmapped`);

  if (plan.unmapped?.length > 0) {
    console.log(`\n⚠️  Unmapped fields (will be skipped):`);
    plan.unmapped.forEach(f => console.log(`    - ${f.label} [${f.type}]`));
  }

  // Step 4: Apply learnings
  plan = await applyLearnings(plan, url);

  // Step 5: Fill + Submit
  console.log('\n── Step 4: Fill & Submit ──');
  const status = await fillForm(url, plan, { otpEmail, otpPassword, workdayEmail, workdayPassword });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Pipeline complete: ${status}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── QUEUE ──────────────────────────────────────────────────────────────────
async function cmdQueue(subcommand, ...args) {
  switch (subcommand) {
    case 'add': {
      const url = args[0];
      if (!url) { console.log('Usage: node cli.mjs queue add <url> [company]'); process.exit(1); }
      const company = args.slice(1).join(' ') || '';
      await addToQueue(url, company);
      break;
    }
    case 'list': {
      const entries = await loadQueue();
      if (entries.length === 0) {
        console.log('📋 Queue is empty. Add URLs with: node cli.mjs queue add <url>');
        return;
      }
      console.log(`\n📋 Application Queue (${entries.length} entries)\n`);
      console.log('  Status     │ Company              │ URL');
      console.log('  ───────────┼──────────────────────┼─────────────────────────────────');
      for (const e of entries) {
        const icon = e.status === 'pending' ? '⏳' : e.status === 'submitted' ? '✅' : e.status === 'failed' ? '❌' : '🔄';
        const status = `${icon} ${e.status}`.padEnd(12);
        const company = (e.company || '—').substring(0, 20).padEnd(20);
        const url = e.url.length > 50 ? e.url.substring(0, 47) + '...' : e.url;
        console.log(`  ${status}│ ${company} │ ${url}`);
      }
      const pending = entries.filter(e => e.status === 'pending').length;
      const done = entries.filter(e => ['submitted', 'applied'].includes(e.status)).length;
      const failed = entries.filter(e => e.status === 'failed').length;
      console.log(`\n  Pending: ${pending}  Applied: ${done}  Failed: ${failed}\n`);
      break;
    }
    case 'remove': {
      const url = args[0];
      if (!url) { console.log('Usage: node cli.mjs queue remove <url>'); process.exit(1); }
      const entries = await loadQueue();
      const filtered = entries.filter(e => e.url !== url);
      if (filtered.length === entries.length) {
        console.log(`  ⚠️  URL not found in queue: ${url}`);
      } else {
        await saveQueue(filtered);
        console.log(`  ✅ Removed from queue: ${url}`);
      }
      break;
    }
    case 'clear': {
      const entries = await loadQueue();
      const kept = entries.filter(e => e.status === 'pending');
      const removed = entries.length - kept.length;
      await saveQueue(kept);
      console.log(`  ✅ Cleared ${removed} completed/failed entries. ${kept.length} pending remain.`);
      break;
    }
    default:
      console.log(`Usage:
  node cli.mjs queue add <url> [company]    Add URL to queue
  node cli.mjs queue list                   Show queue
  node cli.mjs queue remove <url>           Remove URL
  node cli.mjs queue clear                  Clear completed/failed entries`);
  }
}

// ─── BATCH ──────────────────────────────────────────────────────────────────
async function cmdBatch(file) {
  let urls;
  if (file) {
    const content = await readFile(file, 'utf-8');
    urls = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    console.log(`📦 Batch apply: ${urls.length} URLs from ${file}\n`);
  } else {
    // Process queue
    const pending = await getPendingFromQueue();
    if (pending.length === 0) {
      console.log('📋 No pending URLs. Add some with: node cli.mjs queue add <url>');
      console.log('   Or specify a file: node cli.mjs batch targets.txt');
      return;
    }
    urls = pending.map(e => e.url);
    console.log(`📦 Batch apply: ${urls.length} pending URLs from queue\n`);
  }

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[${i + 1}/${urls.length}] ${urls[i]}`);
    console.log(`${'═'.repeat(60)}`);

    try {
      await cmdApply(urls[i]);
      results.push({ url: urls[i], status: 'done' });
    } catch (err) {
      console.error(`❌ Failed: ${err.message}`);
      results.push({ url: urls[i], status: 'error', error: err.message });
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 Batch Summary');
  console.log(`${'═'.repeat(60)}`);
  const ok = results.filter(r => r.status === 'done').length;
  const fail = results.filter(r => r.status === 'error').length;
  console.log(`  ✅ Success: ${ok}`);
  console.log(`  ❌ Failed: ${fail}`);
  console.log(`  Total: ${results.length}`);
}

// ─── STATUS ─────────────────────────────────────────────────────────────────
async function cmdStatus() {
  const stats = await getStats();

  console.log(`
╔════════════════════════════════════════════════════════╗
║          auto-apply — Status                          ║
╚════════════════════════════════════════════════════════╝

Overall:
  Total applications: ${stats.overall.total}
  Submitted: ${stats.overall.submitted}
  Failed: ${stats.overall.failed}
  Success rate: ${stats.overall.total > 0 ? Math.round(stats.overall.submitted / stats.overall.total * 100) : 0}%

By ATS:`);

  for (const [ats, s] of Object.entries(stats.byATS)) {
    const rate = s.total > 0 ? Math.round(s.submitted / s.total * 100) : 0;
    console.log(`  ${ats}: ${s.submitted}/${s.total} (${rate}%)`);
  }

  console.log(`
Learnings:
  Field corrections: ${stats.corrections}
  Option mappings: ${stats.optionMappings}
  Last run: ${stats.lastRun || 'never'}
`);

  // Show CSV report if exists
  const csvPath = resolve(process.cwd(), 'data', 'applied.csv');
  if (existsSync(csvPath)) {
    const csv = await readFile(csvPath, 'utf-8');
    const lines = csv.trim().split('\n');
    console.log(`Recent applications (${lines.length - 1} total):`);
    lines.slice(-6).forEach(l => console.log(`  ${l}`));
  }

  // Show queue status
  const queue = await loadQueue();
  if (queue.length > 0) {
    const pending = queue.filter(e => e.status === 'pending').length;
    const applied = queue.filter(e => ['submitted', 'applied'].includes(e.status)).length;
    const failed = queue.filter(e => e.status === 'failed').length;
    console.log(`\nQueue: ${pending} pending, ${applied} applied, ${failed} failed (${queue.length} total)`);
    if (pending > 0) console.log(`  Run 'node cli.mjs batch' to process pending queue entries.`);
  }
}

// ─── HELP ───────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
auto-apply — Autonomous job application engine

Usage:
  node cli.mjs setup                       Set up your profile
  node cli.mjs scan <url>                  Scan form fields → JSON
  node cli.mjs fill <url> [plan.json]      Fill form (auto-plan if no plan given)
  node cli.mjs apply <url>                 Full pipeline: scan → plan → fill → submit → OTP
  node cli.mjs batch [targets.txt]         Apply to all URLs in file (or process queue)
  node cli.mjs queue add <url> [company]   Add URL to application queue
  node cli.mjs queue list                  Show queue entries
  node cli.mjs queue remove <url>          Remove URL from queue
  node cli.mjs queue clear                 Clear completed/failed entries
  node cli.mjs status                      Show stats & learnings

Options:
  --otp-email <gmail>       Gmail for OTP (or set EMAIL in .env)
  --otp-password <app-pw>   Gmail App Password (or set APP_PASSWORD in .env)

Supported ATS: Greenhouse, Ashby, Lever, Workday, Gem, iCIMS, SmartRecruiters, generic

Examples:
  node cli.mjs apply https://job-boards.greenhouse.io/company/jobs/123
  node cli.mjs queue add https://careers.adobe.com/us/en/job/R167447 Adobe
  node cli.mjs batch                       # process pending queue entries
  node cli.mjs batch targets.txt           # process URLs from file
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  await loadEnv();

  switch (command) {
    case 'setup':  await cmdSetup(); break;
    case 'scan':   await cmdScan(positionalArgs[0]); break;
    case 'fill':   await cmdFill(positionalArgs[0], positionalArgs[1]); break;
    case 'apply':  await cmdApply(positionalArgs[0]); break;
    case 'batch':  await cmdBatch(positionalArgs[0]); break;
    case 'queue':  await cmdQueue(positionalArgs[0], ...positionalArgs.slice(1)); break;
    case 'status': await cmdStatus(); break;
    default:       showHelp();
  }
}

main().catch(err => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
