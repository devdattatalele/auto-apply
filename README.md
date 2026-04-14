# auto-apply

**Autonomous job application engine** — give it your resume, profile, and job URLs. It scans the form, maps every field, fills it, submits, handles OTP, and learns from mistakes.

Built on [Playwright](https://playwright.dev). Works with [Claude Code](https://claude.ai/code) as a `/auto-apply` skill.

```
node cli.mjs apply https://job-boards.greenhouse.io/company/jobs/123
```

---

## Supported Platforms

| ATS | Scan | Fill | Submit | Notes |
|-----|------|------|--------|-------|
| **Greenhouse** | Yes | Yes | Yes | React Select, intl-tel-input, embedded forms |
| **Ashby** | Yes | Yes | Yes | Yes/No buttons, typeahead, custom domains |
| **Lever** | Yes | Yes | Yes | /apply/ navigation, ARIA dropdowns |
| **Workday** | Yes | Yes | Yes | Login/account creation, multi-step wizard, conditional fields |
| **Gem** | Yes | Yes | Yes | Direct application pages |
| **iCIMS** | Yes | Yes | Partial | Detection only |
| **SmartRecruiters** | Yes | Yes | Partial | Detection only |
| **Generic** | Yes | Yes | Yes | Any site with Apply button + standard inputs |

---

## How It Works

```
          ┌──────────┐
  URL ──> │  Scanner  │──> scan.json (all fields, types, options)
          └────┬─────┘
               │
          ┌────▼─────┐
          │  Planner  │──> plan.json (field → profile value mapping)
          └────┬─────┘
               │         ┌──────────────┐
          ┌────▼─────┐   │   Learner    │
          │  Engine   │◄──┤ (corrections │
          └────┬─────┘   │  from past)  │
               │         └──────────────┘
          ┌────▼─────┐
          │  Verify   │──> Re-check every field in DOM
          └────┬─────┘
               │
          ┌────▼─────┐   ┌─────────┐
          │  Submit   │──>│   OTP   │──> Gmail IMAP fetch
          └────┬─────┘   └─────────┘
               │
          ┌────▼─────┐
          │ Reporter  │──> CSV log + screenshots
          └──────────┘
```

**Pipeline per URL:** Detect ATS → Scan form fields → Load profile → Pick best resume → Generate fill plan → Apply past learnings → Fill all fields → Verify every field → Retry empties → Submit → Handle OTP → Log result → Screenshot

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USER/auto-apply.git
cd auto-apply
npm install
npx playwright install chromium
```

### 2. Create Your Profile

```bash
node cli.mjs setup
```

This copies `config/profile.example.yml` → `config/profile.yml`. Edit it with your details:

```yaml
personal:
  first_name: "Jane"
  last_name: "Doe"
  email: "jane.doe@gmail.com"
  phone: "5551234567"
  linkedin: "https://linkedin.com/in/janedoe"
  location: "San Francisco, California"
  city: "San Francisco"
  state: "California"
  postal_code: "94105"
  country: "United States +1"
  country_phone_code: "United States of America (+1)"

eeo:
  gender: "Female"
  hispanic_latino: "No"
  race: "White"
  veteran_status: "I am not a protected veteran"
  disability_status: "I do not want to answer"

work_auth:
  authorized_us: "Yes"
  sponsorship_needed: "No"

education:
  degree: "Bachelor of Science"
  major: "Computer Science"
  university: "Stanford University"
  graduation_year: "2020"

experience:
  years: "5"
  current_company: "Google"
  current_title: "Software Engineer"
```

### 3. Add Your Resume(s)

Place PDF files in `resumes/` and configure `config/resumes.yml`:

```yaml
default: my-resume

resumes:
  - id: my-resume
    file: resumes/my-resume.pdf
    label: "General"
    keywords:
      - software engineer
      - backend
      - python
```

The engine picks the best resume variant by matching JD keywords.

### 4. Set Up OTP (Optional)

For sites that require email verification after submit:

```bash
cp .env.example .env
```

Edit `.env` with your Gmail App Password ([generate one here](https://myaccount.google.com/apppasswords)):

```
EMAIL=you@gmail.com
APP_PASSWORD=xxxx xxxx xxxx xxxx
```

### 5. Apply

```bash
# Single application
node cli.mjs apply https://job-boards.greenhouse.io/company/jobs/123

# Or use the queue
node cli.mjs queue add https://careers.adobe.com/job/R167447 Adobe
node cli.mjs queue add https://jobs.lever.co/stripe/abc123 Stripe
node cli.mjs batch
```

---

## Commands

```
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
```

### `scan` — Inspect a form

```bash
node cli.mjs scan https://jobs.ashbyhq.com/company/job-id
```

Outputs `forms/{slug}-scan.json` with every field: id, name, label, type, options, required status, CSS selector.

### `fill` — Fill without full pipeline

```bash
node cli.mjs fill https://example.com/apply              # auto-generates plan
node cli.mjs fill https://example.com/apply plan.json     # uses custom plan
```

### `apply` — Full pipeline

```bash
node cli.mjs apply https://job-boards.greenhouse.io/verkada/jobs/5039079007
```

Runs: scan → pick resume → generate plan → apply learnings → fill → verify → submit → OTP → log.

### `queue` — Manage application links

```bash
node cli.mjs queue add "https://careers.adobe.com/us/en/job/R167447" Adobe
node cli.mjs queue add "https://jobs.lever.co/stripe/abc123" Stripe
node cli.mjs queue list
# ⏳ pending  │ Adobe   │ https://careers.adobe.com/...
# ⏳ pending  │ Stripe  │ https://jobs.lever.co/...

node cli.mjs batch          # processes all pending queue entries
node cli.mjs queue list
# ✅ submitted │ Adobe   │ https://careers.adobe.com/...
# ✅ submitted │ Stripe  │ https://jobs.lever.co/...
```

### `batch` — Bulk apply

```bash
node cli.mjs batch                    # process pending queue entries
node cli.mjs batch targets.txt        # process URLs from file
```

### `status` — Dashboard

```bash
node cli.mjs status
# Overall:
#   Total applications: 4
#   Submitted: 3
#   Failed: 1
#   Success rate: 75%
#
# By ATS:
#   greenhouse: 2/2 (100%)
#   workday: 1/1 (100%)
#   ashby: 0/1 (0%)
#
# Queue: 2 pending, 3 applied, 0 failed
```

---

## Architecture

```
auto-apply/
├── cli.mjs                  CLI entry point
├── lib/
│   ├── engine.mjs           Core fill engine (15 field type handlers)
│   ├── scanner.mjs          Form field scanner
│   ├── planner.mjs          Auto plan generation (label → profile mapping)
│   ├── discovery.mjs        ATS detection & form navigation
│   ├── fields.mjs           Universal field finder & dropdown handler
│   ├── otp.mjs              Gmail IMAP OTP extraction
│   ├── workday.mjs          Workday login & account creation
│   ├── learner.mjs          Self-learning store
│   └── reporter.mjs         CSV logging, screenshots & queue management
├── config/
│   ├── profile.yml          Your profile (gitignored)
│   ├── profile.example.yml  Template
│   └── resumes.yml          Resume variants & keywords
├── resumes/                 PDF resume files (gitignored)
├── forms/                   Scan & plan JSON files (gitignored)
├── data/
│   ├── applied.csv          Application log
│   ├── queue.csv            Application queue
│   └── learnings.json       Self-learning data
├── screenshots/             Pre/post-submit screenshots (gitignored)
└── targets.txt              Batch URL list
```

### Field Type Handlers

| Type | Handler | Example |
|------|---------|---------|
| text, email, tel, textarea | Direct fill | Name, Email, Phone |
| file | `setInputFiles` | Resume upload |
| select | Native `selectOption` | Country, State |
| dropdown (React Select) | Type-to-filter + click option | Gender, Race |
| custom-select | 4-strategy handler | Workday, Ashby |
| checkbox | Click toggle | Data consent, Terms |
| radio | Click by value or label | Yes/No, Prior worker |
| phone-country | intl-tel-input search | Country code picker |
| typeahead | Type + pick autocomplete | Location, Company |
| yes-no-button | DOM traversal from label | Visa sponsorship (Ashby) |
| multi-select | Type-filter per value | Languages, Skills |

### Self-Learning

The engine records every fill result in `data/learnings.json`:

- **Field failures** — which fields failed and which strategy eventually worked
- **Option corrections** — e.g., profile says "I don't wish to answer" but dropdown has "I do not want to answer"
- **Per-ATS success rates** — tracks submit success by platform
- **Applied automatically** — `applyLearnings()` corrects plan values before each fill

### Dropdown Handler (4 Strategies)

1. **Native select** — `selectOption({ label })` for `<select>` elements
2. **Type-to-filter** — Type value into input, wait for React Select / custom dropdown, click best fuzzy match
3. **Click-scan** — Open dropdown, scan all visible options, click best match
4. **Keyboard navigation** — ArrowDown through options, Enter on match

Each strategy includes fuzzy text matching and verification that the value actually stuck.

---

## Claude Code Integration

auto-apply works as a Claude Code skill. Add it to any project:

```bash
mkdir -p .claude/skills/auto-apply
```

Create `.claude/skills/auto-apply/SKILL.md` — see the included skill file for the full definition.

Then use it in Claude Code:

```
/auto-apply apply https://greenhouse.io/company/jobs/123
/auto-apply queue add https://careers.adobe.com/job/R167447 Adobe
/auto-apply status
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EMAIL` | For OTP | Gmail address for receiving verification codes |
| `APP_PASSWORD` | For OTP | Gmail App Password ([generate](https://myaccount.google.com/apppasswords)) |
| `WORKDAY_EMAIL` | No | Email for Workday account login |
| `WORKDAY_PASSWORD` | No | Password for Workday account login |

---

## Test Results

Tested on real job applications:

| Platform | Company | Fields Filled | Result |
|----------|---------|---------------|--------|
| Greenhouse | Verkada | 14/14 | Submitted |
| Greenhouse | Discord | 18/18 | Filled (custom Qs) |
| Ashby | Perplexity | 11/11 | Filled (anti-bot) |
| Workday | Adobe | 15/15 + 1 conditional | Submitted |

---

## Safety

- **Never headless** — browser always opens visually so you can see what's happening
- **Never auto-submits blindly** — verification pass checks every field before submit
- **Screenshot everything** — pre-submit and post-submit screenshots saved automatically
- **Retry with diagnosis** — submit errors trigger re-scan and re-fill of empty fields
- **No credential storage** — `.env` is gitignored, passwords never logged

---

## License

MIT
