---
description: Open a GitHub PR for the current branch with an auto-generated title and body
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git branch:*), Bash(gh auth status:*), Bash(gh api:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(gh repo view:*), AskUserQuestion
argument-hint: [--draft]
---

Open a GitHub PR for the current branch. Generate the title + body, show them to the user, get confirmation, then create the PR. The user pushes the branch themselves — never run `git push`.

Arguments: `$ARGUMENTS` — if it contains `--draft`, create the PR as draft.

## Pre-flight

Stop with a clear message if any of these fail:

1. `gh auth status` — gh must be authenticated.
2. `git rev-parse --abbrev-ref HEAD` — must not be on `main`/`master`.
3. Determine base branch: try `main`, fall back to `master`. If neither exists, stop.
4. `git log <base>..HEAD --oneline` — if empty, stop ("nothing to PR").
5. `gh pr view --json url,state` on the current branch — if a PR already exists, print its URL and stop. Do NOT create a duplicate.
6. `git status --porcelain` — if there are uncommitted changes, warn the user but do NOT commit them.
7. Verify the branch is on the remote with `gh api repos/{owner}/{repo}/branches/<current-branch>` (or equivalent) — if it 404s, stop and tell the user to push first. Do NOT push for them.

## Generate

Run `git diff <base>...HEAD` and `git log <base>..HEAD --oneline`, then produce:

- **Title**: plain English sentence (NOT `<type>: <subject>` semantic format). Capitalized, present tense, ≤ 72 chars, no trailing period.
- **Body**: three sections, total ~15–25 lines, skim-friendly.
  - `### What`: 2–4 short bullets. Lead with the *why* (bug, gap, user need), then key changes. No opening paragraph. Skip anything obvious from the diff.
  - `### How to test`: commands one per line, no prose, no "expected results". Use only scripts that exist in `package.json` (verify first). Prefix manual steps with `Recommended:` if you didn't run them.
  - `### Security review`: default to single line `No security-impacting changes.` Expand to checklist only when an item is actually affected. Format when expanded:
    - **Secrets / env vars:** <what changed>
    - **Auth / session:** <what changed>
    - **Network / API calls:** <what changed>
    - **Data handling / PII:** <what changed>
    - **Dependencies:** <what changed>

    Omit lines that didn't change.

## Confirm

Show the user the title and body in two separate fenced code blocks. Then call the `AskUserQuestion` tool with the question `Open this PR?` and these three options (in this exact order):

1. `Open PR (Recommended)` — proceeds to the Create step.
2. `Edit first` — let the user edit the title/body, then re-confirm.
3. `Cancel` — stop without creating the PR.

Do NOT create the PR without an affirmative answer from `AskUserQuestion`.

## Create

On confirmation:

1. Run `gh pr create --base <base> --title "<title>" --body "$(cat <<'EOF' ... EOF)"` — pass the body via heredoc so newlines survive. Add `--draft` if requested.
2. Print the PR URL that `gh` returns.

Do not commit on the user's behalf. Do not push under any circumstances — the user pushes the branch before invoking this command. Do not skip the confirmation step.
