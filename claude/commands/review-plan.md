---
description: Codex-powered thorough review of a plan or design document — finds holes, hidden assumptions, and bugs in the plan itself
argument-hint: '[--wait|--background] [path/to/plan.md]'
allowed-tools: Read, Write, Bash(node:*), Bash(ls:*), AskUserQuestion
---

Run a thorough adversarial Codex review of a plan or design document. The plan has NOT been implemented yet — Codex's job is to stress-test the plan itself, not produce code.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest you are about to make changes.
- Your only job is to run Codex and return its output verbatim.

Locating the plan:
1. If the arguments include a path that looks like a file (e.g. `docs/plan.md`, `./plan.md`, an absolute path), resolve it relative to the current working directory and use that file as the review target. Verify it exists with `Read` before invoking Codex.
2. If no path is given, take the most recent plan you (Claude) produced in this conversation, write its full markdown to `/tmp/review-plan-<unix-ts>.md` with the `Write` tool, and use that file as the review target. Do not summarize or trim — write it verbatim.
3. If you cannot locate a plan in either place, ask the user where the plan lives. Do not proceed without a target.

Execution mode rules:
- If the arguments include `--wait`, run in the foreground without asking.
- If the arguments include `--background`, run as a background Bash task without asking.
- Otherwise, recommend foreground (`--wait`) — plan reviews are usually small and fast. Use `AskUserQuestion` exactly once with two options, recommended first:
  - `Wait for results (Recommended)`
  - `Run in background`

Resolving the Codex companion:
- The codex plugin lives under `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`. Resolve the latest version with a **standalone listing** — do NOT use `$(…)` command substitution in the `node` line (Claude Code forces a permission prompt for any command containing `$(…)`, regardless of the allowlist):

```bash
ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null
```

- Take the highest-version path from that listing and **inline it as a literal** in the `node` command below (no `$(…)`, no `$VAR` — shell state doesn't persist across calls anyway).
- If the listing is empty, tell the user to run `/codex:setup` and stop.

Building the prompt:
- Use the heredoc below verbatim, substituting `<PATH>` with the absolute path to the plan file.
- Do NOT pass `--write`. This is read-only review — Codex must not modify any files.
- Do NOT pass `--resume-last`. Each plan review is a fresh Codex thread.

Foreground flow — invoke with the resolved path **inlined as a literal** and the prompt passed as a **single-quoted string argument** (no `$(…)`/heredoc substitution, no `$VAR`). Replace `<COMPANION>` with the path from the listing above and `<PATH>` with the plan file path:
```bash
node "<COMPANION>" task 'You are reviewing a plan / design document. The plan is for a coding change that has NOT been implemented yet — your job is to stress-test the plan itself, not produce code or modify files.

Read the file at <PATH> first. Then review the plan adversarially for: hidden assumptions and where they break under real conditions; missing steps, gaps, or hand-waving; ordering / dependency issues (migration vs deploy ordering, type changes that break callers, schema changes that are not backward-compatible); race conditions and concurrency bugs; security gaps (auth, input validation, replay, token spoofing, IDOR, allowlist bypass); backwards-compatibility, rollback, and data-migration risks; edge cases and failure modes the plan does not address (timeouts, partial failures, retries, idempotency); test coverage gaps (both listed and silently missing); vague language that hides ambiguity (handle gracefully, as needed, if necessary, etc); scope or effort unrealistic for the risk implied; external-system contracts (APIs, webhooks) relied on without verifying.

Rules: if the plan is sound, say so explicitly and stop (do not invent issues to look thorough). If you find issues, list them ordered by severity (Critical / High / Medium / Low); for each, cite the section of the plan it relates to, describe the concrete failure mode, and give a one-line fix or open question. End with a short verdict: Ship as-is, Ship after fixing the Critical/High items, or Re-plan. Do not write code. Do not modify any files. Output one review only.'
```

Background flow:
- Same command (literal path inlined, single-quoted prompt — no `$(…)`), launched via `Bash` with `run_in_background: true`. After launching, tell the user: "Codex plan review started in the background. Check `/codex:status` for progress."

Output rules:
- Foreground: return the stdout of `codex-companion` verbatim — no commentary before or after, no paraphrasing.
- Do not fix any issues Codex raises in the same turn. The user will follow up if they want changes.
