/**
 * learner.mjs — Self-learning store
 *
 * Tracks:
 * - Field failures and which strategy eventually worked
 * - ATS-specific quirks (e.g., "Ashby uses yes-no-button for visa")
 * - Dropdown option text corrections (plan said X, actual option was Y)
 *
 * On future fills, applies learnings to improve success rate.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { detectATS } from './discovery.mjs';

const LEARNINGS_PATH = resolve(process.cwd(), 'data', 'learnings.json');

// ─── Load learnings ─────────────────────────────────────────────────────────
export async function loadLearnings() {
  try {
    if (existsSync(LEARNINGS_PATH)) {
      const raw = await readFile(LEARNINGS_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch { /* corrupted file, start fresh */ }
  return {
    version: 1,
    field_corrections: [],   // { ats, label_pattern, correction }
    option_mappings: [],     // { ats, field_label, plan_value, actual_value }
    ats_quirks: [],          // { ats, quirk, detail }
    results: [],             // { url, company, status, date, errors }
    stats: { total: 0, submitted: 0, failed: 0 },
  };
}

// ─── Save learnings ─────────────────────────────────────────────────────────
async function saveLearnings(data) {
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  await writeFile(LEARNINGS_PATH, JSON.stringify(data, null, 2));
}

// ─── Record a fill result ───────────────────────────────────────────────────
export async function recordResult(url, plan, status, fieldResults = []) {
  const data = await loadLearnings();
  const ats = detectATS(url);

  // Track result
  data.results.push({
    url,
    company: plan.company || '',
    role: plan.role || '',
    ats,
    status,
    date: new Date().toISOString(),
    field_errors: fieldResults.filter(f => f.status !== 'ok').map(f => ({
      field: f.field,
      type: f.type,
      error: f.error || f.status,
    })),
  });

  // Keep last 200 results
  if (data.results.length > 200) {
    data.results = data.results.slice(-200);
  }

  // Update stats
  data.stats.total++;
  if (status === 'submitted' || status === 'submitted-with-otp') {
    data.stats.submitted++;
  } else {
    data.stats.failed++;
  }

  // Learn from field errors
  for (const fr of fieldResults) {
    if (fr.status === 'ok') continue;

    // Check if we already have this correction
    const existing = data.field_corrections.find(c =>
      c.ats === ats && c.field === fr.field
    );

    if (existing) {
      existing.fail_count = (existing.fail_count || 0) + 1;
      existing.last_seen = new Date().toISOString();
    } else {
      data.field_corrections.push({
        ats,
        field: fr.field,
        type: fr.type,
        error: fr.error || fr.status,
        fail_count: 1,
        last_seen: new Date().toISOString(),
      });
    }
  }

  await saveLearnings(data);
}

// ─── Record an option correction ────────────────────────────────────────────
// When the plan says "I don't wish to answer" but the actual option is
// "I do not want to answer", record the mapping for future plans.
export async function recordOptionCorrection(ats, fieldLabel, planValue, actualValue) {
  const data = await loadLearnings();

  const existing = data.option_mappings.find(m =>
    m.ats === ats && m.field_label === fieldLabel && m.plan_value === planValue
  );

  if (existing) {
    existing.actual_value = actualValue;
    existing.count = (existing.count || 0) + 1;
  } else {
    data.option_mappings.push({
      ats,
      field_label: fieldLabel,
      plan_value: planValue,
      actual_value: actualValue,
      count: 1,
    });
  }

  await saveLearnings(data);
}

// ─── Apply learnings to a plan ──────────────────────────────────────────────
// Before filling, check if any field values need correction based on past experience.
export async function applyLearnings(plan, url) {
  const data = await loadLearnings();
  const ats = detectATS(url);
  let corrections = 0;

  for (const fill of (plan.fills || [])) {
    // Check option mappings
    const mapping = data.option_mappings.find(m =>
      m.ats === ats &&
      m.plan_value === fill.value &&
      (m.field_label === fill.label || m.field_label === fill.id)
    );

    if (mapping) {
      console.log(`  🧠 Learning applied: "${fill.label}" → "${mapping.actual_value}" (was "${fill.value}")`);
      fill.value = mapping.actual_value;
      corrections++;
    }
  }

  if (corrections > 0) {
    console.log(`  🧠 Applied ${corrections} learned correction(s)`);
  }

  return plan;
}

// ─── Get success rate by ATS ────────────────────────────────────────────────
export async function getStats() {
  const data = await loadLearnings();
  const byATS = {};

  for (const result of data.results) {
    const ats = result.ats || 'unknown';
    if (!byATS[ats]) byATS[ats] = { total: 0, submitted: 0, failed: 0 };
    byATS[ats].total++;
    if (result.status === 'submitted' || result.status === 'submitted-with-otp') {
      byATS[ats].submitted++;
    } else {
      byATS[ats].failed++;
    }
  }

  return {
    overall: data.stats,
    byATS,
    corrections: data.field_corrections.length,
    optionMappings: data.option_mappings.length,
    lastRun: data.results[data.results.length - 1]?.date || null,
  };
}
