---
name: auto-apply
description: Autonomous job application engine — scan forms, fill fields, submit applications, handle OTP
user_invocable: true
args: command
argument-hint: "[apply <url> | scan <url> | fill <url> | queue add <url> | queue list | list | batch | status | setup]"
---

# auto-apply — Autonomous Job Application Engine

## Command Routing

Determine the command from `{{command}}`:

| Input | Action |
|-------|--------|
| (empty / no args) | Show help menu with all available commands |
| `apply <url>` | Full pipeline: scan → plan → fill → submit → OTP |
| `scan <url>` | Scan form fields → JSON |
| `fill <url> [plan]` | Fill form (auto-generates plan if none given) |
| `queue add <url> [company]` | Add URL to application queue |
| `queue list` | Show queue with status |
| `queue remove <url>` | Remove URL from queue |
| `queue clear` | Clear completed/failed entries |
| `batch [file]` | Process pending queue or URLs from file |
| `list` | Show all applied jobs, pending queue, and remaining targets |
| `status` | Show application stats & learnings |
| `setup` | Create profile.yml from template |
| URL (bare, no sub-command) | Auto-detect: run `apply <url>` |

## Execution

All commands run via the CLI:

```bash
cd "{{project_root}}"
node cli.mjs <command> [args]
```

### Before running any command, check prerequisites:

1. Does `config/profile.yml` exist? If not, tell user to run `setup` or `/auto-apply setup`
2. Is `.env` configured? Warn if OTP won't work without it
3. Are resume PDFs in `resumes/`? Warn if `config/resumes.yml` references missing files

### apply (Full Pipeline)

When user provides a URL (with or without `apply` prefix):

1. Run: `node cli.mjs apply "<url>"`
2. The engine will:
   - Detect ATS platform (Greenhouse/Ashby/Lever/Workday/etc.)
   - Open browser (headed, never headless)
   - Navigate to form
   - Scan all fields
   - Load profile & pick best resume
   - Generate fill plan
   - Apply learnings from past runs
   - Fill every field
   - Verify all fields
   - Submit
   - Handle OTP if needed
   - Take screenshots
   - Log to CSV
3. Report the result to the user

### scan

```bash
node cli.mjs scan "<url>"
```

Outputs `forms/{slug}-scan.json` — show the user a summary of detected fields.

### fill

```bash
node cli.mjs fill "<url>"              # auto-plan
node cli.mjs fill "<url>" "plan.json"  # custom plan
```

### queue

```bash
node cli.mjs queue add "<url>" "Company Name"
node cli.mjs queue list
node cli.mjs queue remove "<url>"
node cli.mjs queue clear
```

### batch

```bash
node cli.mjs batch                  # process pending queue
node cli.mjs batch targets.txt      # process URLs from file
```

### status

```bash
node cli.mjs status
```

Shows: total applications, success rate, per-ATS breakdown, queue status.

## When User Pastes a Job URL

If the user pastes a URL without any command, auto-detect:

1. Check if it's a job posting URL (greenhouse.io, lever.co, ashbyhq.com, workday, etc.)
2. If yes, ask: "Want me to apply to this? I'll scan the form, fill it with your profile, and submit."
3. If confirmed, run `apply`

## Help Menu

When no args:

```
auto-apply — Autonomous Job Application Engine

Commands:
  /auto-apply apply <url>              Full pipeline: scan → fill → submit
  /auto-apply scan <url>               Scan form fields
  /auto-apply fill <url>               Fill form (auto-plan)
  /auto-apply queue add <url> [name]   Add to queue
  /auto-apply queue list               Show queue
  /auto-apply batch                    Process pending queue
  /auto-apply status                   Stats & learnings
  /auto-apply setup                    Create profile

Supported: Greenhouse, Ashby, Lever, Workday, Gem, iCIMS, SmartRecruiters, generic
```
