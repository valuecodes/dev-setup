---
description: Triage open Dependabot alerts, propose a fix plan, then apply (manual commit)
allowed-tools: Bash(gh api:*), Bash(gh repo view:*), Bash(pnpm install:*), Bash(pnpm up:*), Bash(pnpm --filter:*), Bash(pnpm why:*), Bash(pnpm typecheck:*), Bash(pnpm lint:*), Bash(pnpm test:*), Bash(pnpm build:*), Bash(pnpm format:*), Bash(git status:*), Bash(git diff:*), Bash(jq:*), Read, Edit, AskUserQuestion
argument-hint: [--severity=critical|high|moderate|low]
---

Read open Dependabot alerts via `gh api`, propose a triage + fix plan, and apply approved fixes. Two confirmation gates: never proceed past one without my explicit "yes". Do NOT commit. Do NOT push.

Arguments: `$ARGUMENTS` — optional. If `--severity=<level>` is passed, only include alerts at that level or higher (severity order: `critical > high > moderate > low`).

## 1. Pre-flight

1. `git status --porcelain` — if anything matching `package.json`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml` is dirty, STOP and tell me to commit or stash first. Other unrelated WIP is fine but warn me.
2. Resolve `<owner>` and `<repo>` from `gh repo view --json owner,name`.
3. Confirm this is a pnpm workspace by reading `pnpm-workspace.yaml` (or root `package.json` with `packageManager: pnpm@*`). If not, stop — this command only handles npm-ecosystem fixes via pnpm.

## 2. Fetch alerts

Run:

```
gh api repos/<owner>/<repo>/dependabot/alerts?state=open --paginate
```

If the result is empty, say "No open Dependabot alerts." and stop.

For each alert capture:

- `number` (alert ID, used for the summary at the end)
- `security_advisory.severity`
- `security_advisory.summary`
- `security_advisory.cve_id`
- `dependency.package.ecosystem`
- `dependency.package.name`
- `dependency.manifest_path`
- `security_vulnerability.vulnerable_version_range`
- `security_vulnerability.first_patched_version.identifier` (may be null)

Filter to `ecosystem == "npm"`. If a `--severity=<level>` argument was passed, drop anything below that threshold. If filtering leaves zero alerts, say so and stop.

## 3. Classify

For each alert, determine the fix kind:

- **direct** — the package name appears in some workspace's `package.json` `dependencies` / `devDependencies`. Look across all workspaces (root + every member of `pnpm-workspace.yaml`). Record which workspace(s).
- **transitive** — not in any `package.json`. Run `pnpm why <pkg>` to identify the parent that pulls it in (informational only — the fix is an override).
- **no-fix** — `first_patched_version` is null. Mark and surface; do NOT try to fix.

## 4. Group + dedupe

Multiple alerts on the same package collapse to one row. Highest severity wins for display. Keep all alert numbers — they go in the final summary.

## 5. Triage table

Sort by severity (critical → high → moderate → low). Print one table:

```
ALERTS    SEVERITY  PACKAGE     KIND         CURRENT-RANGE → FIX            SUMMARY
#3,#4,#5  high      vite        transitive   *           → >=<patched>      <≤ 80 char summary>
#6,#8     moderate  hono        direct       4.12.12     → ^<patched>       <summary>
#7        moderate  postcss     transitive   *           → >=<patched>      <summary>
#2        moderate  esbuild     transitive   *           → >=<patched>      <summary>
```

## 6. Fix plan

For each row, show the exact action:

- **direct**: `pnpm --filter <workspace> up <pkg>@^<patched>` — bumps the range in that workspace's `package.json`. If the package lives in multiple workspaces, list one command per workspace.
- **transitive**: add to root `package.json` `pnpm.overrides`: `"<pkg>": ">=<patched>"`. After all override edits are queued, run `pnpm install` once.
- **no-fix**: skipped, listed separately under "Held — no patched version available".

**Release-age check.** If `pnpm-workspace.yaml` sets `minimumReleaseAge`, check each target's publish time (`pnpm view <pkg>@<patched> time --json`). When the patched version is younger than the policy, pnpm will refuse it. For that row, plan an exact-version entry `"<pkg>@<patched>"` in `minimumReleaseAgeExclude`, with a comment naming the alert number, and install exactly `<patched>` (not `^<patched>`, which could resolve to an even newer, unexcluded release). Never exclude a bare package name. Mark these rows `(release-age exclude)` in the plan so Gate 1 approves them explicitly.

If every row is `no-fix`, say so and stop — nothing to apply.

**GATE 1.** Call `AskUserQuestion` with the question `Apply this fix plan?` and these three options (in this exact order):

1. `Apply (Recommended)` — proceeds to section 7.
2. `Edit plan` — let the user reclassify rows or adjust target versions, then re-show the plan and re-ask.
3. `Cancel` — stop without applying anything.

Do not edit anything before an affirmative answer.

## 7. Apply (only after Gate 1 = yes)

0. For each `(release-age exclude)` row, first add its approved `minimumReleaseAgeExclude` entry to `pnpm-workspace.yaml` with the `Edit` tool.
1. For each `direct` row, run the confirmed `pnpm --filter <workspace> up <pkg>@^<patched>` command. Show stdout/stderr; if pnpm errors, STOP — do not retry blindly.
2. For all `transitive` rows together, edit root `package.json` to add a `pnpm.overrides` object (or extend an existing one) with each `"<pkg>": ">=<patched>"` entry. Use the `Edit` tool, preserving existing JSON structure and trailing newline.
3. Run `pnpm install` once to apply overrides + sync the lockfile.
4. Run validation, only scripts that exist in the root `package.json`:
   ```
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```
   Show pass/fail for each. If any fail, STOP and surface the failure — do NOT auto-fix in this command.

## 8. Diff + suggested commit

Show `git diff --stat` so I can see what moved. Then print a suggested commit message I can copy-paste:

```
chore(deps): patch dependabot alerts (<N> alerts, <severity-summary>)

addresses: #<alert-number>, #<alert-number>, ...
```

Where `<severity-summary>` is e.g. `2 high, 3 moderate`. The `addresses:` line lists every fixed alert number (not the held ones).

**GATE 2.** Call `AskUserQuestion` with the question `Looks right? (You will commit + push manually.)` and these two options (in this exact order):

1. `Looks good (Recommended)` — proceeds to section 9.
2. `Edit fixes` — let the user request adjustments, then re-validate and re-ask.

Do NOT commit. Do NOT push. Those are manual.

## 9. Final summary

Print one line:

```
Alerts: <total>  Fixed: <N>  Held (no-fix): <N>  Validation: <ok|failed>
```

Then list, on separate lines:

- Fixed alert numbers and the package(s) each one resolved.
- Held alert numbers and why (`no patched version`).
- The validation result (which script passed/failed).

Stop. Leave the working tree dirty for me to commit manually.

## Hard rules

- Never edit `package.json` or run `pnpm install` / `pnpm up` before Gate 1 is confirmed.
- Never include `no-fix` rows in the apply step, even if they share a package name with a fixable row.
- Never commit. Never push. Never use `--no-verify`.
- Never edit source code (anything outside `package.json` / `pnpm-lock.yaml`, plus the approved `minimumReleaseAgeExclude` entries in `pnpm-workspace.yaml`) to "fix" a breaking change. If validation fails after the bump, surface it and stop — that's a separate task.
- Never dismiss an alert via the API. This command only patches; dismissal is manual on GitHub.
- Never widen scope: only the alerts surfaced in section 2 (after severity filter) are in play.
