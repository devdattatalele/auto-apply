# auto-apply — Autonomous Job Application Engine

## What is this

Playwright-based autonomous job application form filler. User provides resume + profile details + job URLs → engine scans each form, auto-generates a fill plan, fills every field, submits, handles OTP, takes screenshots, logs results. Self-learns from failures.

## Architecture

```
cli.mjs                → CLI entry point (setup/scan/fill/apply/batch/queue/status)
lib/
  engine.mjs           → Core fill engine (all field type handlers + verify + submit)
  scanner.mjs          → Form field scanner (extracts inputs/selects/buttons)
  planner.mjs          → Auto plan generation (maps field labels → profile YAML)
  discovery.mjs        → ATS detection & form navigation (Greenhouse/Ashby/Lever/Workday)
  fields.mjs           → Universal field finder, dropdown handler, fuzzy matching
  otp.mjs              → Gmail IMAP OTP extraction & entry
  workday.mjs          → Workday account creation & login
  learner.mjs          → Self-learning store (tracks failures, corrections)
  reporter.mjs         → Screenshots, CSV logging & queue management
```

## Supported ATS Platforms

- **Greenhouse** — React Select dropdowns, intl-tel-input phone, embedded forms
- **Ashby** — Yes/No button toggles, typeahead location, custom domain support
- **Lever** — /apply/ path navigation, ARIA dropdowns
- **Workday** — Login/account creation, multi-step wizard, conditional fields
- **Gem** — Direct application pages
- **iCIMS** — Detection, generic fill
- **SmartRecruiters** — Detection, generic fill
- **Generic** — Any form with Apply button + standard inputs

## Commands

```bash
node cli.mjs setup                       # Create config/profile.yml
node cli.mjs scan <url>                  # Scan form → forms/{slug}-scan.json
node cli.mjs fill <url> [plan.json]      # Fill form (auto-plans if no plan.json)
node cli.mjs apply <url>                 # Full pipeline: scan → plan → fill → submit → OTP
node cli.mjs batch [targets.txt]         # Apply to all URLs (or process queue)
node cli.mjs queue add <url> [company]   # Add URL to queue
node cli.mjs queue list                  # Show queue
node cli.mjs queue remove <url>          # Remove from queue
node cli.mjs queue clear                 # Clear completed entries
node cli.mjs status                      # Show stats & learnings
```

## Config Files

- `config/profile.yml` — User profile (personal info, EEO, work auth, education)
- `config/resumes.yml` — Resume variants with keyword matching
- `.env` — Gmail credentials for OTP (EMAIL, APP_PASSWORD)
- `targets.txt` — Job URLs to batch apply

## Data Files

- `data/applied.csv` — Application log (date, company, role, url, status, ats)
- `data/queue.csv` — Application queue (pending/applied/failed)
- `data/learnings.json` — Self-learning corrections
- `forms/` — Scan JSONs and fill plans
- `screenshots/` — Pre/post-submit screenshots

## Key Rules

- **Always headed browser** — never use headless mode
- **Profile is gitignored** — never commit personal data
- **Verify before submit** — every field re-checked in DOM
- **Screenshot everything** — evidence of what was filled/submitted
- **Self-learn** — record results, apply corrections on future fills

## Dependencies

- `playwright` — Browser automation
- `imapflow` — Gmail IMAP for OTP
- `js-yaml` — YAML config parsing
