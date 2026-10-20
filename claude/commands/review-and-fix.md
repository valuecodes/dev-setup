---
description: Thorough PR review (security + bugs) + Codex review, auto-fix all findings, run quality gates, recap
argument-hint: '[--base <ref>]'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(node:*), Bash(pnpm:*), Bash(ls:*), AskUserQuestion, Task
---

Run a full pre-ship gate on the current branch in one shot: a thorough review (security + bugs), an independent Codex review, auto-fix every valid finding, run the repo quality gates and fix failures, then recap.

Arguments: `$ARGUMENTS` — optionally `--base <ref>` to override the base branch.

## Hard rules

- **Never** run `git commit`, `git add`, `git push`, `git stash`, or any command with `--no-verify`. This command only edits the working tree. Committing/pushing is the user's job (they use an SSH key with a passphrase — pushing would block).
- Do not stop after the reviews. The whole point is to also *fix* the findings and get the quality gates green.
- Fix the underlying problem — never silence a check (no eslint-disable, no `as any`, no skipping tests) unless that is genuinely the correct fix and you say why.

## Step 1 — Pre-flight & scope

1. Determine the base branch: use `--base <ref>` from `$ARGUMENTS` if given; else `main` if it exists, else `master`. If neither exists, stop.
2. Compute the review scope — everything not on the base:
   - Committed branch diff: `git diff --name-only <base>...HEAD`
   - Uncommitted changes: `git status --porcelain` (includes untracked).
3. If both are empty, report "nothing to review" and stop.
4. Show the user the resolved base and the list of files in scope.

## Step 2 — Thorough Claude review

Review the **full scope** (committed `git diff <base>...HEAD` **and** uncommitted `git diff` / new files). Read each changed file with enough surrounding context to judge correctness — do not review hunks in isolation.

Cover, at minimum:
- **Correctness / logic bugs**, off-by-one, wrong conditionals, broken control flow.
- **Security**: injection, secrets/credentials in code, authz/authn gaps, unsafe handling of user input, SSRF, path traversal, unsafe deserialization, XSS.
- **Error handling & edge cases**: nulls/undefined, empty arrays, unhandled rejections, missing `await`.
- **Concurrency / resource issues**: race conditions, leaks, unbounded work.
- **Type-safety holes**: `any`, unsafe casts, non-null assertions that can fail.
- **Obvious performance regressions**.

For breadth on large diffs, you MAY fan out parallel review subagents (`Task`) — e.g. one for security, one for correctness — and merge their findings.

Produce a **numbered findings list**, each with: `file:line`, severity (critical/high/medium/low), and a one-line description. Keep it; you will fix these in Step 4.

## Step 3 — Codex review

Run the Codex reviewer as an independent second opinion (`/codex:review` cannot be invoked directly — it disables model invocation — so call its companion script):

```bash
node "$(ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)" review --wait
```

- `--wait` runs it in the foreground so you capture the output.
- If the script path can't be found (Codex plugin not installed), say so and continue with only the Step 2 findings — do not fail the whole command.

Parse Codex's findings into the same numbered format and **dedupe** against Step 2 (don't double-fix the same issue).

## Step 4 — Address all findings

Work through the combined list from Steps 2 + 3:
- Apply a fix to the working tree for every **valid** finding.
- If you judge a finding to be a **false positive**, do not change code — record it and a one-line reason instead.
- Re-read each file after editing to confirm the fix is coherent with surrounding code.

No commits.

## Step 5 — Quality gates + fix loop

Run these in order. After any failure, fix the cause and re-run that gate until it passes, then continue:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. `pnpm format:check` — if it fails, run `pnpm format` to fix, then re-check.
5. `pnpm build`

If a gate genuinely cannot be made to pass (e.g. a pre-existing unrelated failure, or a fix that needs a product decision), stop looping on it and report it clearly in the recap rather than retrying blindly or disabling the check.

## Step 6 — Final recap

Print a concise summary:
- **Findings**: count from Claude vs Codex, grouped by severity.
- **Fixes applied**: bullet per fix with `file:line`.
- **Dismissed**: any false positives and why.
- **Quality gates**: pass/fail for each of the five, with notes on anything left red.
- **Files touched**: from `git status --porcelain`.

End by reminding the user to review the diff and run `/commit` + push when satisfied. Do **not** commit or push.
