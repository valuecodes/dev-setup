---
description: Build a feature end-to-end — execute the chat's plan in a worktree, commit, self+Codex review, fix, open PR, wait, address PR feedback
argument-hint: '[optional: feature description]'
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Task, TodoWrite, AskUserQuestion, Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(node:*), Bash(ls:*), Bash(mkdir:*), Bash(sleep:*), Bash(cd:*), Bash(tail:*), Bash(head:*), Bash(grep:*), Bash(sed:*), Bash(sort:*), Bash(ssh-add:*), Bash(setsid:*), Bash(kill:*), Bash(fuser:*), Bash(ss:*), Bash(readlink:*), Bash(cp:*)
---

Drive a feature from idea to addressed-PR in one run: take the spec → isolate it in a git worktree → build → commit → review (your own security/bug review **and** an independent Codex review) → fix and commit → open a PR → wait for automated review → triage and address that feedback.

**Intended workflow:** the user plans normally in this chat (plan mode), gets a plan, *then* runs `/ship-feature` to execute it. So the spec comes from the plan already in this conversation — see Phase 1. Any text passed as arguments (`$ARGUMENTS`) is only a fallback description for ad-hoc features when there's no plan.

This command *owns* the commits and pushes. It runs **fully automatically from spec through build** — auto-committing locally (the worktree branch is isolated, reversible, and unpushed) — and **gates only the three actions that leave the machine**: push + open PR (Gate C), the PR-feedback push (Gate D), and posting replies (Gate E). Never pass one of those gates without an affirmative `AskUserQuestion` answer.

**Visibility without editor windows.** This command does **not** open VS Code windows. It cannot close them either: the `code` remote CLI has no close command, and WSL cannot reach the Windows-side window manager. So do not try. Instead, after the first green commit it restarts the web dev server on `http://localhost:3000/` from the worktree (Phase 4a), killing the previous one, so localhost always shows the latest build. The Gate C diff is the other place to see the work.

## Hard rules

- **Push only over the repo's HTTPS URL via the `gh` token** — never over the SSH `origin` (it would block on the key passphrase, which the non-interactive shell can't answer). Never `--no-verify`. Never force-push.
- **Signing fallback (never block on it).** Decide signing once in Phase 0. If commit signing can't run non-interactively, make every commit with `-c commit.gpgsign=false` (unsigned) and warn the user once. As a safety net, if any commit still fails with a signing error, retry that exact commit once with `-c commit.gpgsign=false`. Never use `--no-verify` for this (it also skips hooks). Caveat: if the base branch *requires* signed commits, unsigned pushes are rejected — surface that and STOP instead.
- Never **push** or post without passing the relevant gate (C / D / E); local commits are automatic (the worktree branch is unpushed and reversible). Never `--no-verify`. Never force-push.
- Never post PR replies without Gate E. Never reply to your own past comments.
- **Emit `gh`/`git` commands so the allowlist matches.** Write each as a single command that *starts with the tool name* (`gh api …`, `git -C … …`) with literal values inlined. Do NOT hoist values into leading `VAR=…;` assignment statements and do NOT use a leading `VAR=val gh …` env prefix — Claude Code splits on `;`/newlines and matches each sub-command independently, and it does not strip env-var prefixes, so either form defeats `Bash(gh:*)`/`Bash(git:*)` and forces a needless permission prompt. (Process wrappers `timeout`/`time`/`nice`/`nohup`/`stdbuf` are fine — those are stripped.) Any piped helper needs its own rule too: `gh api … | head` requires both `gh` and `head` (both already allowed here).
- **Change files only with the Edit and Write tools**, never through a shell script (`python3 - <<'EOF'`, `node -e`, `sed -i`, `perl -pi`, `cat > file <<EOF`). A script can run anything, so no allow rule can safely cover it and it prompts every time, while Edit/Write on worktree paths is allowlisted. Several edits to one file are several Edit calls. Run follow-up commands such as `pnpm -C .worktrees/<slug> format` and `git -C .worktrees/<slug> status --short` as separate Bash calls, not chained with `;`.
- Fix root causes — never silence a check (no `eslint-disable`, no `as any`, no skipped tests) unless it is genuinely the correct fix and you say why.
- Do all feature work in the worktree. **Never auto-remove it** — always keep it and print the manual cleanup hint at the end. Never delete the `feat/<slug>` branch (the PR depends on it).

## Phase 0 — Pre-flight (read-only, fail fast)

1. `gh auth status` must succeed. If it fails, STOP and tell the user to run `gh auth login` (a fine-grained PAT scoped to this repo works — it needs Contents R/W, Pull requests R/W, Metadata R, Commit statuses R, Actions R, and Workflows R/W only if the feature touches `.github/workflows/**`). Do not continue.
2. Derive the HTTPS URL: `gh repo view --json url -q .url` → append `.git` → `<https-url>`. Also capture `<owner>`/`<repo>` (`gh repo view --json owner,name`).
3. Confirm the gh credential helper authenticates **non-interactively**: `git ls-remote <https-url> HEAD`. If it prompts or fails, STOP with the fix. NOTE: this proves read access + no passphrase prompt only — it does NOT prove push permission. Write access is genuinely verified at the first push (Gate C); if the PAT lacks `Contents: write`, that push fails with a 403 and the command stops there.
4. Toolchain: `node --version` must match `.nvmrc`. If not, STOP and tell the user to `nvm use`.
5. Capture `git status --porcelain` in the main checkout. If there's unrelated WIP, warn (the worktree isolates the new work, so it's safe to proceed, but flag it).
6. Base branch = `main` if it exists, else `master`. If neither, STOP.
7. **Signing pre-flight.** If `git config --get commit.gpgsign` is `true`, check signing can run non-interactively. For `gpg.format=ssh`: `ssh-add -l` must succeed and list a key. If it can't (no agent / `SSH_AUTH_SOCK` unset), set `SIGN=off` for this run — all commits use `git -c commit.gpgsign=false commit …` — and warn once: "Commits will be UNSIGNED — the signing key is passphrase-protected and no ssh-agent is available non-interactively. To keep them verified, run `eval \"$(ssh-agent)\" && ssh-add ~/.ssh/id_ed25519` before `/ship-feature`." If signing works, commit normally. If the base branch requires signed commits and `SIGN=off`, STOP.

## Phase 1 — Establish the spec (no gate)

**Primary path — execute the plan from this chat.** Use the implementation plan agreed earlier in THIS conversation as the feature spec; it's already in your context. (If the conversation was compacted and you can't see it, locate the most recent plan file — newest `<repo>/.plans/*/plan.md`, then newest in `~/.claude/plans/` — and use that.) Summarize the plan as the build spec and seed `TodoWrite` from its steps. Do **not** re-run a full clarification — the plan *is* the spec; only ask if something is genuinely missing or contradictory.

**Fallback — no plan in the chat.** If `$ARGUMENTS` carries a description, run a brief clarify Q&A via `AskUserQuestion` (scope / constraints / acceptance) — one or two rounds, don't interrogate. If there's neither a plan nor a description, ask what to build.

Derive the slug + branch name `feat/<slug>` now (used in Phase 2). The **unit folder** (`<unit>` below, an absolute path) for this run is `<repo-root>/.plans/<slug>/`; `/ship-plan` and `/ship-issue` override it with their own (`ship-plan.md` Phase 0 step 3 defines the layout). Every draft file this command writes goes there, never into `.git/`: Claude Code treats `.git/` as a protected path and prompts on every write there. Before the first write, `mkdir -p` the unit folder and make sure `.plans/` is ignored (the Phase 2 step 1 check). Then, so the session isn't left titled "Ship feature", print one paste-ready line for the user (you cannot rename the session yourself — `/rename` is user-only):

```
Tip: run /rename <slug> to retitle this session.
```

**Codex plan review (auto, before the build).** Stress-test the *plan itself* before any build effort, then adjust it:

1. Write the build spec (the plan summary, verbatim — don't trim) to `<unit>/spec.md` (in the workspace and locally ignored, so it's never tracked or pushed; fixed name so no `date`/timestamp call is needed). When `/ship-plan` or `/ship-issue` already wrote the spec there, review that file as it is.
2. Resolve the companion path **without command substitution** (a `$(…)` forces a permission prompt every run): run `ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null` and take the highest-version path. If none is found, print "Codex companion not found — skipping plan review (run /codex:setup to enable)" and go straight to Phase 2. Never abort the run over this.
3. Run foreground with the path **inlined as a literal** and the prompt passed as a **single-quoted string argument** — no `$(…)`/heredoc substitution and no `$VAR` (both force a prompt or break across calls); no `--write`, no `--resume-last` (fresh thread). Replace `<PATH>` with the temp file's absolute path:
   ```bash
   node "<resolved-absolute-path>" task --model gpt-6-sol 'You are reviewing a plan / design document. The plan is for a coding change that has NOT been implemented yet — your job is to stress-test the plan itself, not produce code or modify files.

   Read the file at <PATH> first. Then review the plan adversarially for: hidden assumptions and where they break; missing steps, gaps, or hand-waving; ordering / dependency issues (migration vs deploy, type changes that break callers, non-backward-compatible schema changes); race conditions and concurrency bugs; security gaps (auth, input validation, replay, token spoofing, IDOR, allowlist bypass); backwards-compatibility, rollback, and data-migration risks; edge cases and failure modes (timeouts, partial failures, retries, idempotency); test-coverage gaps (listed and silently missing); vague language that hides ambiguity (handle gracefully, as needed, etc); scope/effort unrealistic for the risk; external-system contracts relied on without verifying.

   Rules: if the plan is sound, say so explicitly and stop (do not invent issues). If you find issues, list them ordered by severity (Critical / High / Medium / Low); for each, cite the plan section, describe the concrete failure mode, and give a one-line fix or open question. End with a short verdict: Ship as-is, Ship after fixing the Critical/High items, or Re-plan. Do not write code. Do not modify any files. Output one review only.'
   ```
4. Triage the findings (mirror Phase 6): fold every **valid** finding into the build spec and re-seed `TodoWrite` as needed; for a **false positive**, leave the plan unchanged and record a one-line reason.
5. Print a short recap — Codex's verdict, what it raised, what changed in the plan, what was rejected and why — then the **revised** build spec, and **proceed directly to Phase 2** (no gate here — the plan was already approved in chat). Phase 0's fail-fast STOP conditions still apply.

## Phase 2 — Create the worktree from fresh remote state

The worktree lives **inside** the repo at `.worktrees/<slug>` (not a sibling dir), so it stays
within Claude Code's workspace root — project settings apply and there are no out-of-workspace
prompts. It does not match the `apps/*`/`packages/*`/`tooling/*` workspace globs, so the outer
install ignores it.

1. Ensure `.worktrees/` is ignored locally (no committed repo change): if `git -C <repo-root>
   check-ignore .worktrees` doesn't already match, append `.worktrees/` to
   `<repo-root>/.git/info/exclude`. This keeps the worktree from showing as untracked. Do the
   same for `.plans/` (`mkdir -p <repo-root>/.plans`). It holds the unit folders and the dev
   server's PID and log (Phase 4a). It is not under `.claude/` or `.git/`, because Claude Code
   treats both as protected paths and prompts on every write there.
2. Branch from the *remote* base, not the possibly-stale local ref:
   ```bash
   git fetch <https-url> <base>
   git rev-parse FETCH_HEAD    # -> <base_sha>
   ```
3. Slugify the feature → branch `feat/<slug>`, worktree dir `.worktrees/<slug>` (relative to the
   repo root).
4. **Collision handling:** if `git rev-parse --verify feat/<slug>` succeeds OR `.worktrees/<slug>`
   already exists / is in `git worktree list`, append a numeric suffix (`feat/<slug>-2`, dir
   `…-2`, …) until both are free — or ask the user. Never reuse or clobber an existing
   branch/worktree.
5. `git worktree add .worktrees/<slug> -b feat/<slug> <base_sha>`.
6. **Seed `node_modules`.** The frozen install is the slowest step that isn't the build. If
   `<repo-root>/node_modules` exists, hardlink-copy it into the worktree before installing:
   `cp -al <repo-root>/node_modules .worktrees/<slug>/node_modules`. Do the same for every
   workspace package that has its own (`apps/web/node_modules`, `packages/*/node_modules`,
   `tooling/*/node_modules`; list them with `ls -d`). pnpm already hardlinks between its store and
   `node_modules`, so this uses no extra disk, and nothing edits `node_modules`.
7. Install deterministically: `pnpm install --frozen-lockfile` with the worktree as cwd
   (node_modules aren't shared across worktrees; the pnpm store is). On a seeded tree it only
   verifies and relinks what changed. If the seed is stale, the install repairs it. If the
   lockfile is out of date this fails loudly — surface it, don't fall back to a mutating install.
8. Do all subsequent work in the worktree (run pnpm with the worktree as cwd, and git via
   `git -C ".worktrees/<slug>"`).

## Phase 3 — Build the feature (auto)

Implement per the agreed plan. Follow repo standards from `AGENTS.md`: TS strict, minimal targeted edits, reuse existing patterns, exact-pinned deps (no `^`/`~`) that satisfy the workspace `minimumReleaseAge`. Tick off `TodoWrite` items as you go. No gate here.

## Phase 4 — Commit the build (no gate)

1. Make the first commit green — run in order, fix failures and re-run that gate until it passes:
   `pnpm typecheck` → `pnpm lint` → `pnpm knip` → `pnpm test` → `pnpm format:check` (fix with `pnpm format`) → `pnpm build`. If a gate genuinely can't pass (pre-existing unrelated failure / needs a product decision), stop looping and report it instead of disabling the check.
2. Stage everything (`git add -A`), then show the **full** preview including untracked files: `git diff --cached` + `git status` (plain `git diff` omits new files).
3. Propose a semantic commit message `<type>: <subject>` (`feat`/`fix`/`docs`/`style`/`refactor`/`test`/`chore`, no scope, imperative, ≤72 chars).

**Commit (no gate).** Commit automatically — the diff above is informational only; this is a local, unpushed commit on the isolated worktree branch and is reviewable in full at Gate C: `git commit -m "<msg>"` (already staged; prepend `-c commit.gpgsign=false` if Phase 0 set `SIGN=off`). Never `--no-verify`.

Then run **Phase 4a**, then continue with Phase 5.

### Phase 4a — Restart the dev server from this worktree

This is best effort. Never fail or pause the ship over the dev server. On any problem, print the tail of the log and move on.

1. **Stop the previous server.** If `.plans/dev.pid` exists, run `kill -- -<pid>` and ignore errors. The server was started with `setsid`, so it leads its own process group and this also stops Vite's children. Then run `fuser -k 3000/tcp` to clear any other listener. `apps/web`'s dev script is `vite --port 3000` without `strictPort`, so a busy port would silently move Vite to 3001. Confirm with `ss -ltnp` that nothing listens on `:3000`.
2. **Start it detached** so it outlives this session. Run it from the worktree with pnpm's `-C` flag (no `cd`, no `$VAR`):
   ```bash
   setsid nohup pnpm -C .worktrees/<slug> --filter web dev > .plans/dev.log 2>&1 &
   ```
3. Launch `sleep 5` as a **background** Bash command. On resume, run `ss -ltnp` and read the `pid=` of the `:3000` listener. Write that PID to `.plans/dev.pid` with the Write tool. If nothing listens on `:3000`, print `tail -40 .plans/dev.log` and continue.
4. Print `Dev: http://localhost:3000/`. If the spec names an example to look at, append `?code=<example>`. Vite hot-reloads the fix commits made later in the same worktree. The next ship run replaces the server.

## Phase 5 — Review: self + Codex (auto)

**Self review**: deep pass over the branch diff `git diff <base_sha>...HEAD`, reading enough context to judge correctness — not hunks in isolation. Cover: correctness/logic bugs; security (injection, secrets, authz/authn, unsafe input, SSRF, path traversal, unsafe deserialization, XSS); error handling & edge cases (nulls, empty arrays, unhandled rejections, missing `await`); concurrency/resource (races, leaks, unbounded work); type-safety holes (`any`, unsafe casts, non-null assertions); obvious perf regressions. You MAY fan out parallel `Task` subagents (e.g. security + correctness). Produce a numbered findings list: `file:line`, severity, one-line description.

**Codex review** — independent second opinion, run explicitly against the worktree + branch diff. Run it in **two steps** — never embed a `$(…)` command substitution in the `node` line, since Claude Code forces a permission prompt for any command containing `$(…)` regardless of the allowlist:

1. Resolve the companion path with a standalone listing (no substitution): `ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null` and take the highest-version path. If none is found, say so and continue with self-review only.
2. Invoke it with that path **inlined as a literal** (no `$(…)`, no `$VAR` — shell state doesn't carry across calls anyway):
   ```bash
   node "<resolved-absolute-path>" review --model gpt-6-sol --cwd ".worktrees/<slug>" --base "<base_sha>" --scope branch --wait 2>&1 | tail -60
   ```

`--wait` runs foreground so you capture output. Parse Codex findings into the same numbered format and **dedupe** against the self review.

## Phase 6 — Address findings + commit fixes (no gate)

1. Fix every **valid** finding in the worktree. For a **false positive**, don't change code — record it with a one-line reason. Re-read each file after editing to confirm coherence. Fix root causes.
2. Re-run the full quality-gate loop (Phase 4 step 1) until green.
3. If nothing needed fixing, say so and skip to Phase 7. Otherwise stage (`git add -A`) and show `git diff --cached` + `git status`, with a message like `fix: address review findings`.

**Commit (no gate).** Commit the fixes automatically (local, unpushed — reviewable at Gate C): `git commit -m "<msg>"` (prepend `-c commit.gpgsign=false` if Phase 0 set `SIGN=off`). Never `--no-verify`.

## Phase 7 — Push + open PR (Gate C)

1. Pre-flight: current branch is not the base; `gh pr view --json url,state` shows no existing PR for `feat/<slug>` (if one exists, print its URL and skip to Phase 8).
2. Generate, from `git diff <base_sha>...HEAD` and `git log <base_sha>..HEAD --oneline`:
   - **Title**: plain-English sentence, capitalized, present tense, ≤72 chars, no trailing period (NOT `<type>: <subject>`).
   - **Body**: `### What` (2–4 bullets, lead with the why), `### How to test` (commands one per line, only scripts that exist in `package.json`), `### Security review` (single line `No security-impacting changes.` unless an item is actually affected, then the checklist).
3. Show title + body in two fenced blocks.

**Gate C.** `AskUserQuestion` (`Push and open this PR?`): `Push + open PR (Recommended)` / `Edit first` / `Cancel`. On affirmative, first write the body with the **Write tool** to `<unit>/pr-body.md` (in the workspace and locally ignored, so it's never tracked or pushed; fixed name so no timestamp call is needed), then:
```bash
git -C ".worktrees/<slug>" push <https-url> HEAD:feat/<slug>
gh pr create --base <base> --head feat/<slug> --title "<title>" --body-file <unit>/pr-body.md
```
Use `--body-file` (not `--body "$(cat …)"`) — a `$(…)` command substitution forces a permission prompt every run regardless of the allowlist, and `--body-file` preserves newlines anyway. Print the PR URL. If the push 403s, the PAT lacks `Contents: write` — STOP and report.

## Phase 8 — Wait for automated review (bounded polling)

1. Right after the PR is created, record the creation timestamp and baseline counts of issue comments + review comments + reviews.
2. Poll for *new* automated review activity — do NOT just sleep a flat 5 min, and do NOT treat CI checks finishing as review completion (bots like Codex / CodeRabbit post on their own schedule). Loop:
   - Launch `sleep 60` as a **background** Bash command (foreground sleep is disallowed; backgrounding yields the turn and re-invokes you on exit).
   - On resume, re-fetch the three comment sources and compare counts to the baseline.
3. Stop when **either** new comments/reviews have appeared *and* counts held steady for one extra interval (review settled), **or** a max wait (~10 min) is reached. Report what arrived (or `no automated review within <max>`) and proceed.

## Phase 9 — Address PR feedback (Gates D + E)

**Paginate every fetch** — never assume one page is enough.

1. Fetch (skip comments authored by your own login). Get that login by running `gh api user --jq .login` as its **own standalone command** and capturing the value — never inline it as `$(gh api user …)`, which forces a permission prompt. Then:
   - `gh api --paginate repos/<owner>/<repo>/issues/<PR>/comments`
   - `gh api --paginate repos/<owner>/<repo>/pulls/<PR>/comments`
   - `gh api --paginate repos/<owner>/<repo>/pulls/<PR>/reviews`
   - Checks: `gh pr checks <PR>` (exit 8 = "not all complete", parse anyway); for each `failure`, `gh run view <runId> --log-failed | tail -60`.
2. Triage. First print a one-line check summary: `Checks: <N> ✓ · <N> ✗ · <N> ⏳`. Then classify each comment AND each failed check:
   - **valid** — concrete claim or actionable suggestion grounded in the diff. Will be fixed. Replies posted.
   - **question** — clarifying question; no code change, but reply needed.
   - **noise** — bot welcome / "review enabled" / auto-generated PR overview / "show summary per file" / known-flaky CI failure. No fix, no reply by default.
   - **approved** — APPROVED review with no concrete request. Acknowledge with `👍 thanks`, no fix.
   - **ci-failure** — a failed Action / check that points at a real problem in the diff (test/typecheck/lint/format). Will be fixed. NO reply (CI re-runs after push). Use the check name as `AUTHOR`, the failed-job URL as the `id`, and a one-line root cause (from the failed log tail) as the summary.

   Show one table:
   ```
   ID           AUTHOR                FILE:LINE                  CLASS         ONE-LINE SUMMARY
   <id>         <user | check-name>   <path:line | -->           <class>       <≤ 90 chars>
   ```
   Then a fix plan for every `valid` / `ci-failure` row, grouping related fixes (same file or shared root cause) into one edit when natural:
   ```
   [id <id>]  <file>(:line)
     → <one-line description of the change>
   ```
3. Apply fixes for valid + ci-failure (if any) in the worktree; re-run the quality gates until green.

**Gate D** (only if there ARE code fixes). `AskUserQuestion` (`Commit + push the fixes?`): `Commit + push (Recommended)` / `Edit fixes` / `Cancel`. On affirmative → `git -C ".worktrees/<slug>" add -A`, commit (`fix: address PR review feedback`), `git -C ".worktrees/<slug>" push <https-url> HEAD:feat/<slug>`. Capture the new SHA (`git -C ".worktrees/<slug>" rev-parse HEAD`).

4. Draft replies: `valid` → `Fixed in <sha>: <one line>.`; `question` → answer directly; `approved` → `👍 thanks`. Skip `ci-failure` (CI re-runs after push) and `noise`.

**Gate E** (whenever there is *anything* to post — replies to questions or approvals still require it even if **zero** code fixes were needed). `AskUserQuestion` (`Post these replies (and resolve fix-landed threads)?`): `Post (Recommended)` / `Edit drafts` / `Cancel`. On affirmative:
- Review/line comment → `gh api --method POST repos/<owner>/<repo>/pulls/<PR>/comments/<id>/replies -f body="<reply>"`.
- General PR comment → `gh pr comment <PR> --body "<reply>"`.
- Resolve only **fix-landed** threads (reply starts with `Fixed in <sha>:`). List threads via paginated GraphQL — `reviewThreads(first:100, after:$cursor)` following `pageInfo.endCursor`/`hasNextPage`, and page each thread's `comments` too; then `resolveReviewThread` per matched thread. Do NOT resolve noise/question/approved/ci-failure/deferred threads.

Only skip to the summary if there is genuinely nothing actionable *and* nothing to reply to.

## Final summary

Print: worktree path + branch; commit SHA(s); PR URL; `Dev: http://localhost:3000/` (or that it is not running); findings (self vs Codex, by severity); fixes applied; PR comments triaged/fixed/replied/resolved; quality-gate status.

**Worktree (no gate).** Always **keep** the worktree — never auto-remove it. End the summary with the manual cleanup hint for when the user is done: `git worktree remove .worktrees/<slug>`. Run it from `<repo-root>`, and first stop the dev server if it serves from that worktree: `kill -- -<pid from .plans/dev.pid>`. The tree is clean after the commit, so add `--force` only if it refuses because of leftover ignored or build files. **Never delete the `feat/<slug>` branch** — the pushed branch and PR depend on it.
