/**
 * planner.mjs — Auto-generate fill plan from scan + profile
 *
 * Maps scanned field labels to profile YAML keys automatically.
 * No manual plan.json creation needed.
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { fuzzyScore } from './fields.mjs';

// ─── Field label → profile key mapping ──────────────────────────────────────
// Each entry: [regex to match field label, path in profile.yml, optional transform]
const FIELD_MAP = [
  // Personal
  [/^first\s*name$/i, 'personal.first_name'],
  [/^last\s*name$/i, 'personal.last_name'],
  [/^(full\s*)?name$/i, 'personal.full_name'],  // resolved as first + last
  [/^email/i, 'personal.email'],
  [/phone\s*device\s*type/i, '_static.Mobile'],
  [/country\s*phone\s*code/i, 'personal.country_phone_code'],
  [/phone\s*number/i, 'personal.phone'],
  [/^phone/i, 'personal.phone'],
  [/linkedin/i, 'personal.linkedin'],
  [/portfolio|website|url|shared\s*url/i, 'personal.linkedin'],
  [/^city$/i, 'personal.city'],
  [/^state$/i, 'personal.state'],
  [/^postal\s*code$|^zip/i, 'personal.postal_code'],
  [/^address\s*line\s*1$/i, 'personal.address_line1'],
  [/^address\s*line\s*2$/i, 'personal.address_line2'],
  [/location/i, 'personal.location'],
  [/^country$/i, 'personal.country'],
  [/address/i, 'personal.location'],

  // Work auth
  [/sponsor|visa/i, 'work_auth.sponsorship_needed'],
  [/authorized.*work|legally.*work|eligible.*work|work.*authorization/i, 'work_auth.authorized_us'],

  // EEO
  [/gender/i, 'eeo.gender'],
  [/hispanic|latino/i, 'eeo.hispanic_latino'],
  [/race|ethnicity/i, 'eeo.race'],
  [/veteran/i, 'eeo.veteran_status'],
  [/disability/i, 'eeo.disability_status'],

  // Education
  [/degree/i, 'education.degree'],
  [/major|field\s*of\s*study/i, 'education.major'],
  [/university|school|college|institution/i, 'education.university'],
  [/graduat|year/i, 'education.graduation_year'],
  [/gpa/i, 'education.gpa'],

  // Experience
  [/years?\s*(of\s*)?experience/i, 'experience.years'],
  [/current\s*(company|employer)/i, 'experience.current_company'],
  [/current\s*(title|role|position)/i, 'experience.current_title'],
  [/salary|compensation|pay/i, 'experience.salary_expectation'],
  [/notice\s*period|start\s*date|available|earliest/i, 'experience.start_date'],

  // Office / hybrid / location
  [/office|on-?site|in-?person|hybrid|come\s*into/i, 'work_auth.office_willing'],
  [/relocat/i, 'work_auth.willing_to_relocate'],
  [/remote/i, 'work_auth.remote_preference'],
  [/currently\s*(located|based)\s*(in\s*the)?\s*US/i, 'work_auth.authorized_us'],
  [/preferred\s*(first\s*)?name/i, 'personal.first_name'],

  // Prior worker / employed before
  [/prior\s*worker|previously\s*worked|former\s*employee|employed.*in\s*the\s*past|self\s*identify.*prior/i, '_static.No'],

  // How did you hear — use "Job Boards" as universal fallback
  [/how\s*did\s*you\s*hear|referral|source/i, '_static.Job Boards'],
];

// ─── Load profile ───────────────────────────────────────────────────────────
export async function loadProfile(profilePath) {
  const raw = await readFile(profilePath || resolve(process.cwd(), 'config', 'profile.yml'), 'utf-8');
  const profile = yaml.load(raw);

  // Resolve full_name from first + last
  if (profile.personal) {
    profile.personal.full_name = `${profile.personal.first_name || ''} ${profile.personal.last_name || ''}`.trim();
    // If city isn't explicitly set, extract from location
    if (!profile.personal.city && profile.personal.location) {
      profile.personal.city = profile.personal.location.split(',')[0].trim();
    }
    // If state isn't explicitly set, extract from location
    if (!profile.personal.state && profile.personal.location) {
      const parts = profile.personal.location.split(',');
      if (parts.length > 1) profile.personal.state = parts[1].trim();
    }
  }

  return profile;
}

// ─── Get value from nested path ─────────────────────────────────────────────
function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ─── Pick resume based on JD keywords ───────────────────────────────────────
export async function pickResume(jdText, resumesPath) {
  const raw = await readFile(resumesPath || resolve(process.cwd(), 'config', 'resumes.yml'), 'utf-8');
  const config = yaml.load(raw);
  const resumes = config.resumes || [];
  const defaultId = config.default || resumes[0]?.id;

  if (resumes.length <= 1) return resumes[0]?.file || null;

  const jdLower = jdText.toLowerCase();
  let bestResume = null;
  let bestScore = 0;

  for (const resume of resumes) {
    let score = 0;
    for (const kw of (resume.keywords || [])) {
      if (jdLower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestResume = resume;
    }
  }

  if (bestResume && bestScore >= 2) {
    console.log(`  📄 Resume picked: ${bestResume.label} (${bestScore} keyword matches)`);
    return bestResume.file;
  }

  const fallback = resumes.find(r => r.id === defaultId) || resumes[0];
  console.log(`  📄 Resume: ${fallback.label} (default)`);
  return fallback.file;
}

// ─── Generate fill plan from scan + profile ─────────────────────────────────
export async function generatePlan(scan, profile, { resumePath, jdText, url } = {}) {
  const fills = [];
  const skipped = [];
  const unmapped = [];

  for (const field of (scan.fields || [])) {
    let label = (field.label || '').replace(/\*+/g, '').trim();
    const type = field.type;

    // Skip recaptcha
    if (/recaptcha/i.test(field.id) || /recaptcha/i.test(field.name) || /g-recaptcha/i.test(field.id)) {
      skipped.push({ label: label || field.id, reason: 'Cannot auto-solve reCAPTCHA' });
      continue;
    }

    // Skip duplicate radio entries (Workday scans each radio as a separate field)
    if (type === 'radio' && field.id && /\.(true|false)$/.test(field.id)) {
      const baseId = field.id.replace(/\.(true|false)$/, '');
      if (fills.some(f => f.id?.startsWith(baseId)) || skipped.some(f => f.id?.startsWith(baseId))) continue;
      // Use the base ID for mapping, and try to derive a better label from the ID
      field.id = baseId;
      field.name = baseId;
      // Convert IDs like "candidateSelfIdentifyAsPriorWorker" to meaningful labels
      const idLabel = baseId.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
      if (label === 'Yes' || label === 'No') {
        field.label = idLabel;
        label = idLabel;
      }
    }

    // Skip hidden/search inputs
    if (/search|select__input/i.test(field.id) || /search|select__input/i.test(field.name)) continue;

    // Resume file field — upload to any file input that accepts PDF (first one = resume)
    if (type === 'file') {
      const accept = field.accept || '';
      const isResume = /resume|cv/i.test(label) || /resume/i.test(field.id) || accept.includes('pdf');
      if (isResume && resumePath && !fills.some(f => f.type === 'file')) {
        fills.push({
          ...field,
          value: resumePath,
        });
      }
      continue;
    }

    // Yes/No button (Ashby pattern)
    if (type === 'yes-no-button') {
      let value = null;
      for (const [regex, path] of FIELD_MAP) {
        if (regex.test(label)) {
          value = getNestedValue(profile, path);
          break;
        }
      }
      if (value) {
        fills.push({ ...field, value });
      } else {
        unmapped.push({ label, type, reason: 'No profile mapping for yes/no question' });
      }
      continue;
    }

    // Checkbox — data consent
    if (type === 'checkbox') {
      if (/agree|consent|acknowledge|terms|privacy/i.test(label) || /agree|consent/i.test(field.name)) {
        fills.push({ ...field, value: true });
      }
      continue;
    }

    // Try to map label to profile value
    let mapped = false;
    for (const [regex, path] of FIELD_MAP) {
      if (regex.test(label)) {
        let value;
        if (path.startsWith('_static.')) {
          value = path.substring(8); // literal string after _static.
        } else {
          value = getNestedValue(profile, path);
        }
        if (value !== undefined && value !== null && value !== '') {
          fills.push({ ...field, value: String(value) });
          mapped = true;
          break;
        }
      }
    }

    // For select fields with options: if the mapped value doesn't match any option,
    // try fuzzy matching against option text and use the best match
    if (mapped && fills.length > 0 && (type === 'select' || type === 'select-one') && field.options?.length > 0) {
      const lastFill = fills[fills.length - 1];
      const val = lastFill.value;
      const exactMatch = field.options.some(o => o.value === val || o.text === val);
      if (!exactMatch) {
        let bestOpt = null, bestScore = 0;
        for (const opt of field.options) {
          const score = fuzzyScore(val, opt.text);
          if (score > bestScore) { bestScore = score; bestOpt = opt; }
        }
        if (bestOpt && bestScore >= 0.3) {
          lastFill.value = bestOpt.text;
        }
      }
    }

    if (!mapped && label) {
      unmapped.push({ label, type, id: field.id });
    }
  }

  // Determine company/role from scan title
  const title = scan.title || '';
  const company = title.split(/[@|–—-]/).pop()?.trim() || '';
  const role = title.split(/[@|–—-]/)[0]?.trim() || '';

  const plan = {
    url: url || scan.original_url || scan.url,
    company,
    role,
    resume: resumePath,
    fills,
    dynamic_fills: [],
    skipped,
    unmapped,
    auto_generated: true,
    generated_at: new Date().toISOString(),
  };

  return plan;
}
