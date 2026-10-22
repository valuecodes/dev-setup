---
description: Review the permission prompts since the last run (from the session transcripts), triage each command shape into a prefix rule / hook form / keep prompting, apply the approved ones and verify them
argument-hint: '[--days N | --since ISO]'
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, TodoWrite, AskUserQuestion, Bash(node ~/.claude/scripts/prompted-commands.mjs:*), Bash(node ~/.claude/hooks/allow-worktree-commands.test.mjs:*), Bash(ls:*)
---

Cut repeated permission prompts **without widening what can run unattended**. Every change is gated; nothing is added automatically. Arguments: `$ARGUMENTS`: an optional `--days N` or `--since <ISO>` overriding the last-run time.

**Files.**
- Scanner: `~/.claude/scripts/prompted-commands.mjs` (read-only; modes `shapes`, `list`, `decisions <regex>`; see its header).
- Hook: `~/.claude/hooks/allow-worktree-commands.ts` (segment checker; its header lists every allowed form). Its tests: `~/.claude/hooks/allow-worktree-commands.test.mjs` (one `[command, "allow" | "prompt"]` line per case).
- Global settings: `~/.claude/settings.json` (`permissions.allow`, `permissions.additionalDirectories`, `hooks`).
- Last run: `~/.claude/permission-review.last` (one ISO timestamp).

## Phase 1 — Scan (read-only)

1. Since = `$ARGUMENTS` if given, else the timestamp in `~/.claude/permission-review.last`, else 7 days ago.
2. `node ~/.claude/scripts/prompted-commands.mjs shapes --since <since>`. Read the ranked table: count, approved/rejected, last time, projects, shape, latest example.
3. Drop shapes that are inherent and never rule material: `AskUserQuestion`, `ExitPlanMode`, `Skill`, edits to `~/.claude/` itself, and one-off scratch commands (a single occurrence that will not recur, such as a test harness written in a session).
4. For each remaining shape, check what *should* have covered it: the `allow` rules in `~/.claude/settings.json`, the project's `.claude/settings*.json`, and the hook's allowed forms (its header). To test an example against the hook, add it as a case to the test file and run it. If something should have covered it but it still prompted, it is a **broken rule**: confirm with `node ~/.claude/scripts/prompted-commands.mjs decisions '<regex>' --since <rule date>` (`source` = `user_temporary` means it prompted).

## Phase 2 — Triage

Put each shape in exactly one bucket, with a one-line reason a reviewer can check.

**A. Prefix rule** `Bash(<cmd> <sub>:*)`, or an exact string `Bash(<whole command>)`: only when **every possible argument** after the prefix is harmless, because an allow rule bypasses the hook's narrower checks. Good examples: `ps`, `pgrep`, `readlink`, `which`, `pkg-config`, `ls`, `git rev-parse`, `git ls-tree`, `git check-ignore`, `cargo fmt/check/clippy/test`, `rustup toolchain list`. For reads outside the workspace (like Cargo's crate sources), prefer a safe folder in `additionalDirectories` over a broad `grep`/`cat` rule.

**B. Hook form**, a new matcher in `allow-worktree-commands.ts`: when the command has variable parts **in the middle** (worktree paths, `-C <dir>`, file paths), or is safe only with some arguments (`gh api` GET vs `-X POST`, `ss -ltnp` vs `ss -K`, `gitleaks dir` vs `--report-path`), or is only ever written chained or piped. The hook sees the whole command line; the tokenizer already refuses `$`, backticks, redirects, globs, `~` expansion, grouping and newlines, and splits on `;` `&&` `||` `|`. A new form is a small named function plus prompt-and-allow test cases.

**C. Keep prompting** (default when unsure). Always C:
- anything that publishes or changes remote state: `git push`, `gh pr create/merge/comment`, `gh issue edit/comment/close`, `gh api` with `-X`/`--method`/`-f`/`-F`/`--input`, graphql mutations
- installing or running downloaded or arbitrary code: `pnpm install/add/dlx/exec`, `cargo install/run`, `npx`, `docker run`, `node -e`/`python3 -c`/heredoc scripts, `sh -c`
- deleting or overwriting: `rm`, `git reset/checkout/clean`, `--force`, `--amend`, `kill` beyond the hook's dev-server check
- reading or writing outside the workspace in ways that could expose secrets (`~/.ssh`, `~/.claude/.credentials.json`, `.env`)
- `cd <dir> && …` (Claude Code flags it on purpose). The fix there is a habit, not a rule: say which allowed form to use instead, and add it to the relevant instructions file if it keeps recurring.

**Hard-won rules:**
- **Never write a rule with `*` in the middle.** `Bash(cp -al *node_modules .worktrees/*node_modules)` never matched. Only a trailing `*` works (`Bash(x:*)`, `Bash(git worktree add .worktrees/*)`).
- **Prefer global** (`~/.claude/settings.json`) for generic tools. Use project settings only for project-specific scripts.
- A pinned tool version in a rule (e.g. `cargo +1.95.0 fmt:*`, the Codex companion `codex/1.0.4/…`) needs updating when the version changes. Say so when proposing one.
- **Broken-rule fixes come first**: they are prompts the user already agreed to remove.

## Phase 3 — Gate

Show one table per bucket: shape, count, example, proposed rule or hook form, reason. Then `AskUserQuestion` (multiSelect) per bucket A and B, at most 4 options per call (use several calls when needed), each option one proposed change, recommended ones first. Bucket C is listed for information only. Change nothing that was not selected.

## Phase 4 — Apply + verify

1. **Rules:** edit `~/.claude/settings.json` with the Edit tool (keep the existing order and grouping; remove rules a new hook form replaces, and rules shown to be broken). Then validate it with exactly this command, which the hook approves: `node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8")); console.log("valid")'`.
2. **Hook forms:** add the matcher to `allow-worktree-commands.ts`, list it in the header comment, and add cases to `allow-worktree-commands.test.mjs`: the real example from the scan as `allow`, and for every way the form could be abused, a `prompt` case (other flags, paths outside the intended folder, `..`, symlinks, `$()`, redirects, pipes into `sh`). Run `node ~/.claude/hooks/allow-worktree-commands.test.mjs`; every case must pass, old ones included. The editor's TypeScript errors in the hook (missing Node types) are noise; Node strips the types without checking them.
3. Write the current time (ISO) to `~/.claude/permission-review.last` with the Write tool.
4. If an instructions file (`CLAUDE.local.md` or `~/.claude/CLAUDE.md`) lists the auto-approved forms, update it.

## Phase 5 — Recap

Print what was added (rules, hook forms), what was removed, the test result, and what was kept prompting and why. Then tell the user:
- the hook is read fresh on every call; settings changes may need a Claude Code restart
- to check later, run `node ~/.claude/scripts/prompted-commands.mjs decisions '<regex>' --since <now>`: a working rule shows `user_permanent`/`rule`, `config` or `hook`, never `user_temporary`; or simply run `/permission-review` again
