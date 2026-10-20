---
description: Generate a PR title and description from the current branch's diff vs main (does not create a PR)
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git branch:*)
---

Generate a PR title and description from the diff for this repository. Do NOT run `gh pr create` or any other PR-creation command — only produce the text for me to copy-paste.

Steps:

1. Determine the base branch — default to `main`. If `main` does not exist, fall back to `master`. If neither exists, tell me and stop.
2. Run `git diff <base>...HEAD` and `git log <base>..HEAD --oneline` to see what would land in the PR.
3. If the diff is empty (current branch has no commits beyond the base), tell me and stop.
4. Otherwise produce the output described below.

## PR Title

A plain English sentence describing what the PR does. Rules:

- Plain sentence — do NOT use `<type>: <subject>` semantic-commit format.
- Start with a capital letter, present tense, imperative-ish (e.g. "Add argument parsing to the CLI", "Cover main output with tests", "Align ESLint config across packages").
- <= 72 chars, no trailing period.
- Mention the area touched when helpful (cli, tests, tooling, config, docs).

## PR Description (Required Sections)

### What
- Start with a 3–5 sentence description (plain text, no bullets).
- Then add optional bullet points describing what changed and why.
- Call out affected areas like `src/`, tests, or config files when relevant.
- If CLI behavior/output changes, note the change and any new flags or args.

### How to test
Provide concrete, reproducible steps using scripts that ACTUALLY exist in this repo. Before listing a command, verify it is defined in `package.json` (root or relevant workspace). Common ones in this repo:
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm dev` (when behavior is part of the change)

Include expected results (what "good" looks like). If you did not run something, say so and list what should be run. Do NOT invent scripts — if a script you'd want to suggest does not exist, omit it or note that it would need to be added.

### Security review
Always include a short checklist-style review:
- **Secrets / env vars:** <changed | not changed>. (Never add real secrets to the repo.)
- **Auth / session:** <changed | not changed>.
- **Network / API calls:** <changed | not changed>. (New external calls, endpoints, telemetry.)
- **Data handling / PII:** <changed | not changed>. (Logging, storage, user-provided data.)
- **Dependencies:** <added/updated | not changed>. (Call out any new deps and why; prefer minimal deps.)

If no impact, write exactly: `No security-impacting changes identified.` Then add 1–2 bullets justifying.

## Output format

Output two fenced code blocks back-to-back so each is independently copy-pasteable:

1. First block (label `text`): just the title, one line.
2. Second block (label `markdown`): the full description body, starting with `## What`.

No preamble, no explanation, no "here is your PR" wrapper text. Just the two blocks.

Tone: Concise and high-signal. Use bullet points. Do not invent scripts/commands/files that are not in the repo.
