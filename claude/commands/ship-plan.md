---
description: Ship the next unshipped PR of a multi-PR plan file against main — whole-plan Codex review once, per-PR re-plan + Codex review, then the /ship-feature build/review/PR/feedback phases — and stop until it is merged
argument-hint: '[path/to/plan.md] [--continue]'
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Task, TodoWrite, AskUserQuestion, Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(node:*), Bash(ls:*), Bash(mkdir:*), Bash(sleep:*), Bash(cd:*), Bash(tail:*), Bash(head:*), Bash(grep:*), Bash(sed:*), Bash(sort:*), Bash(ssh-add:*), Bash(setsid:*), Bash(kill:*), Bash(fuser:*), Bash(ss:*), Bash(cat:*), Bash(readlink:*), Bash(cp:*)
---

Ship a plan that is split into several PRs (`## PR A …`, `## PR B …`, …) **one PR per run**, each PR branched from fresh `main` and merged before the next one starts. Every run: resolve the plan and a state file → reconcile with git/GitHub → (first run only) Codex-review the whole plan → re-plan the next PR and Codex-review that spec → run the `/ship-feature` build/commit/review/fix/PR/feedback phases for it → stop with a "merge, then run again" hint.

**Why not stacked PRs, and why one PR per run.** This repo merges by rebase only (SHAs are rewritten on merge), feature CI runs only for PRs that target `main`, and Copilot review only fires on PRs that target `main`. A PR based on another feature branch would therefore be untested and unreviewed, and every merge would force a rebase + force-push of everything above it. Sequential PRs against `main` avoid all of that. One PR per run keeps each build inside a fresh context: the model cannot run `/compact` itself, so the design must not depend on controlling compaction. Progress lives in a state file, not in the conversation.

**Housekeeping this command does that `/ship-feature` does not.** It keeps a state file for the plan (Phase 0). It removes worktrees, and their local branches, when GitHub reports the PR as merged and the tree is clean (Phase 1b). It stops polling as soon as Copilot has reviewed (Phase 5). It inherits from `/ship-feature` the rest: no VS Code windows, the dev server restart on `http://localhost:3000/` (Phase 4a) and `node_modules` seeding.

**Relationship to `/ship-feature`.** This command does not duplicate it. Phases 4–5 below say "follow `~/.claude/commands/ship-feature.md` Phases N–M verbatim": read that file and execute those phases with the overrides listed here. Its hard rules all apply (HTTPS push via the gh token only, signing fallback with `-c commit.gpgsign=false`, never `--no-verify`, never force-push, allowlist-friendly command shapes with no `$(…)` / leading `VAR=` prefixes, never auto-remove a worktree, never delete a `feat/*` branch, local commits automatic, gates C/D/E before anything leaves the machine). If `ship-feature.md` has dropped out of context after a compaction, re-read it before continuing a phase.

Arguments: `$ARGUMENTS` — an optional plan path and an optional `--continue` flag.

## Phase 0 — Resolve plan + state (read-only)

1. **Plan file.** Use, in order: a path in `$ARGUMENTS`; the `plan:` path recorded in the newest state file (`ls -t .plans/*/state.md`); the newest `.plans/*/plan.md` that contains at least two `^## PR ` headings (`grep -l`, then `ls -t`); the newest such `*.md` in `~/.claude/plans/`; else ask the user. Read it in full. If it is `.plans/<x>/plan.md`, the **plan folder** is `.plans/<x>/`; otherwise it is an external plan and step 3 copies it into a plan folder.
2. **Parse PR sections.** Every `^## PR <id> — <title>` heading is one PR. Branch = the first backticked `feat/...` in the heading, else `feat/<slugified title>`. Worktree = `.worktrees/<branch without feat/>`. Body = text up to the next `## ` heading. Everything before the first PR heading (`## Context`, standing rules, decided order) is **shared spec context** for every PR; the `## Order and dependencies` section (if any) is the authoritative order.
3. **Plan folder** `<repo-root>/.plans/<plan-slug>/` (hidden like `.worktrees/`, excluded locally via `.git/info/exclude`, so it is reviewable in the editor, never committed, and never dirties the main checkout). **Not under `.claude/` or `.git/`:** Claude Code treats both as protected paths, so every write there prompts, whatever `allowed-tools` or permission rules say. Before the first write: `mkdir -p <repo-root>/.plans`, and if `git -C <repo-root> check-ignore .plans` does not match, append `.plans/` to `<repo-root>/.git/info/exclude` (the same mechanism ship-feature uses for `.worktrees/`; no repo change). **One-time migration:** if `<repo-root>/.claude/plans/` exists and holds `*.state.md`, `*.review.md`, `*.specs/` or `dev.*` files from an older version of this command, and `<repo-root>/.plans/` does not exist yet, `mv .claude/plans .plans` (list the contents first; if anything else lives there, move only those files) and say so.

   **Layout.** This is the one definition; `/plan-to-issues`, `/ship-issue` and `/ship-feature` refer to it.

   ```
   .plans/
     <plan-slug>/
       plan.md          the plan; state.md's plan: always points here
       state.md         this command's progress table
       issues.md        /plan-to-issues issue map
       epic.md          epic body as drafted by /plan-to-issues
       prs/<id>/        the unit folder for PR <id>
         spec.md        expanded spec (Phase 3)
         issue.md       issue body (/plan-to-issues)
         pr-body.md     PR body (ship-feature Phase 7)
         replies.md     reply drafts (/ship-issue guard)
     <feature-slug>/    standalone /ship-feature run: the unit files directly inside
     issue-<n>/         /ship-issue for an issue no plan folder maps: the unit files directly inside
     dev.pid, dev.log   repo-wide dev server
     repo-info.md       /repo-info draft
   ```

   **`<plan-slug>`** comes from the plan's `# title`, never from its file name (plan mode saves plans under generated names like `i-want-to-build-eager-patterson.md`): lowercase it, drop anything in parentheses, drop a trailing word `plan`, turn every run of non-alphanumeric characters into `-`, trim `-` from both ends, and cut to at most 50 characters at a `-`. `# Private Context AI — desktop MVP (local chat) plan` → `private-context-ai-desktop-mvp`.

   **Copying an external plan in.** If `.plans/<plan-slug>/` already exists, decide by origin, never by title (titles change between revisions): when its `state.md` or `issues.md` has a `source:` line with this same path, reuse the folder; otherwise `AskUserQuestion` (`Same plan as .plans/<plan-slug>/?`): `Reuse this folder` / `New folder <plan-slug>-2` / `Cancel`. Never add the suffix silently. Then `mkdir -p .plans/<plan-slug>/prs`, and `cp <external path> .plans/<plan-slug>/plan.md` unless that `plan.md` already exists (it is then the canonical copy; do not overwrite it). Record the external path as `source:` in `state.md`. From then on read only `plan.md`; Codex reads it there too, inside the workspace.

   **State file** `.plans/<plan-slug>/state.md`. Format:

   ```
   plan: <absolute path of .plans/<plan-slug>/plan.md>
   source: <external plan path>           # only when the plan was copied in
   plan-reviewed: <date> <verdict>        # absent until Phase 2 has run
   last-run: <date> base <sha>

   | id | branch | worktree | status | pr | notes |
   |----|--------|----------|--------|----|-------|
   | A  | feat/flow-jumps | .worktrees/flow-jumps | built | — | base f27a01e |

   ## Plan review notes
   - A: …      # valid whole-plan Codex findings, applied at that PR's Phase 3
   - rejected: … (reason)
   ```

   `status` ∈ `pending | planned | built | pushed | merged | closed`. If the file exists and names a **different** plan path than the one resolved in step 1, `AskUserQuestion` before overwriting it (`Switch state to the new plan?` / `Keep the recorded plan` / `Cancel`). If it does not exist, create it with every PR as `pending`.
4. **Pre-flight.** Run `ship-feature.md` **Phase 0** verbatim (gh auth, HTTPS URL + owner/repo, non-interactive `git ls-remote`, Node vs `.nvmrc`, main-checkout WIP warning, base branch, signing fallback → `SIGN`). Its STOP conditions apply.

## Phase 1 — Reconcile state with git and GitHub

**Fast-forward the main checkout first.** `git fetch <https-url> main`; if `git rev-parse --abbrev-ref HEAD` is `main` and `git status --porcelain` is empty, `git merge --ff-only FETCH_HEAD` (never a rewrite; if it cannot fast-forward, say so and continue). If the checkout is dirty or on another branch, skip and warn once. This keeps the "commits ahead of main" counts below and the editor view honest; the worktree base is always `FETCH_HEAD` anyway.

For **every** PR in the plan (including ones not yet in the table, so the first run adopts work done by earlier `/ship-feature` runs), refresh:

- `git rev-parse --verify <branch>` → branch exists? `git worktree list` → worktree path? `git log --oneline main..<branch>` → commits ahead?
- `gh pr list --head <branch> --state all --json number,state,url,mergedAt` → PR number/state/URL.

Derive the status: PR merged → `merged`; PR open → `pushed`; PR closed and not merged → `closed` (STOP and ask what to do; never reopen or rebuild silently); branch with commits ahead and no PR → `built`; branch with no commits ahead → `planned`; no branch → `pending`. Update the table and `last-run`, then print it.

### Phase 1b — Clean merged worktrees

For each `.worktrees/*` entry in `git worktree list --porcelain` (branch from its `branch refs/heads/…` line), check two things: `gh pr list --head <branch> --state merged --json number,url` returns a PR, **and** `git -C <wt> status --porcelain` is empty. Only when both hold:

1. If `.plans/dev.pid` exists and `readlink /proc/<pid>/cwd` lies inside that worktree, stop the dev server first (`kill -- -<pid>`, see Phase 4a).
2. `git worktree remove <wt>`; if it refuses only because of ignored files (`node_modules`, build output), retry with `--force` — porcelain already proved the tree clean.
3. `git branch -D <branch>` (`-D`, not `-d`: rebase merges rewrite SHAs so git cannot see the branch as merged; GitHub's `merged` state is the guard).

Never touch a worktree that is dirty, whose PR is open or closed-unmerged, that has no PR, or that belongs to the PR about to ship. Print the removed list. This deliberately overrides ship-feature's "never auto-remove the worktree" rule for the merged-and-clean case only.

**Next = the first PR in plan order whose status is not `merged`.** Then:

- If any **earlier** PR is `pushed` (open PR): STOP — print its URL and `Merge PR #<n>, then run /ship-plan again.` With `--continue`, instead poll: launch `sleep 60` as a **background** Bash command, on resume `gh pr view <n> --json state,mergedAt`, repeat up to 30 minutes, then re-run this phase. If still open after 30 minutes, STOP with the same hint.
- If next is `pushed`: skip to **Phase 5** (PR feedback only). Do not rebuild.
- If next is `built`: `git fetch <https-url> main`, then compare `git merge-base main <branch>` with `git rev-parse FETCH_HEAD`. Equal → the branch is on the current `main`; skip to **Phase 4** at the push step (ship-feature Phase 7, Gate C). Different → STOP and report that the branch needs a rebase onto `main` (a rewrite + force-push, which this command never does); let the user decide.
- Otherwise (`pending` / `planned`): continue to Phase 2.

Print one paste-ready line so the session is not left titled "Ship plan": `Tip: run /rename <branch slug> to retitle this session.`

## Phase 2 — Whole-plan Codex review (first run only)

Skip when the state file has a `plan-reviewed:` line. Otherwise:

1. The review target is the plan folder's `plan.md` itself (inside the workspace, so Codex can read it; no copy needed).
2. Resolve the Codex companion with a standalone listing (no `$(…)`): `ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null`; take the highest-version path. If none: print "Codex companion not found — skipping plan review (run /codex:setup to enable)", write `plan-reviewed: <date> skipped` and go to Phase 3.
3. Run foreground with the path **inlined as a literal** and the prompt as a **single-quoted string** (no `$(…)`, heredoc, or `$VAR`; no `--write`; no `--resume-last`), replacing `<PATH>` with the file's absolute path:
   ```bash
   node "<resolved-absolute-path>" task --model gpt-6-sol 'You are reviewing a plan / design document that is split into several pull requests, to be shipped one after another against main. Nothing has been implemented yet beyond what the plan itself says is already merged — your job is to stress-test the plan itself, not produce code or modify files.

   Read the file at <PATH> first. Then review the plan adversarially for: hidden assumptions and where they break; missing steps, gaps, or hand-waving; ordering / dependency issues between the PRs (a PR relying on something a later PR adds, type changes that break callers, changes that are not backward-compatible); race conditions and concurrency bugs; security gaps; backwards-compatibility and rollback risks; edge cases and failure modes; test-coverage gaps (listed and silently missing); vague language that hides ambiguity; scope/effort unrealistic for the risk; external-system contracts relied on without verifying.

   Rules: if the plan is sound, say so explicitly and stop (do not invent issues). If you find issues, list them ordered by severity (Critical / High / Medium / Low); for each, name the PR it belongs to, cite the plan section, describe the concrete failure mode, and give a one-line fix or open question. End with a short verdict: Ship as-is, Ship after fixing the Critical/High items, or Re-plan. Do not write code. Do not modify any files. Output one review only.'
   ```
4. Triage: every **valid** finding becomes a bullet under `## Plan review notes` in the state file, keyed by PR id (it is applied when that PR reaches Phase 3). **False positives** get a `rejected:` bullet with a one-line reason. Set `plan-reviewed: <date> <verdict>`.
5. Print a short recap (verdict, what was raised, what was recorded, what was rejected and why). No gate — the plan was already approved in chat when it was written.

## Phase 3 — Re-plan the next PR + Codex review of that spec (Gate A)

Later PR sections in these plans are deliberately sketches ("specified to the level needed to re-plan each briefly before its run"), and earlier PRs have landed since the plan was written. So:

1. **Build spec** = shared spec context + this PR's section + its `## Plan review notes` bullets. Read every file the section names and check each assumption against the code **as it is now on `main`**. Expand the section into the same shape as a fully specified PR: **Design / Files / Tests / Verification**, with concrete file paths, function names and test names. Do not widen scope beyond the section; anything that belongs to a later PR goes into a `Deferred` note. Seed `TodoWrite` from the Files + Tests lists.
2. Show the expanded spec, then **Gate A** — `AskUserQuestion` (`Build this spec for PR <id>?`): `Build (Recommended)` / `Edit first` / `Cancel`. This gate exists because the per-PR expansion was not approved in chat; ask it even when the section was already full-length. On `Edit first`, apply the user's edits and re-ask. On `Cancel`, update the state file and stop.
3. Write the approved spec with the Write tool to `.plans/<plan-slug>/prs/<id>/spec.md` (`mkdir -p` the unit folder; fixed name per PR, so a resumed run or a post-compaction turn re-reads it instead of re-deriving it, and the user can review it in the editor) and run the **Codex plan review from `ship-feature.md` Phase 1** on that file (same companion resolution, same single-quoted prompt, `--model gpt-6-sol`). Fold valid findings into the spec file and `TodoWrite`; record rejected ones with a reason. Print the recap and the revised spec. No second gate.
4. Set the row to `planned`; note `base <FETCH_HEAD sha>` once Phase 4 fetches it.

## Phase 4 — Build, commit, review, fix, push, PR

Read `~/.claude/commands/ship-feature.md` and follow its **Phases 2–7 verbatim** (worktree from fresh remote `main` → build → first commit → self + Codex code review → fix commit → Gate C push + PR), using the spec file from Phase 3 as "the plan", with these overrides:

- **Names come from the plan heading**: branch `feat/<slug>`, worktree `.worktrees/<slug>`. The collision rule still applies to *unexpected* existing branches, but a branch Phase 1 classified as `built` for this PR is **adopted**, never suffixed. For `built`, skip straight to ship-feature Phase 7.
- **Unit folder** = `.plans/<plan-slug>/prs/<id>/`: ship-feature writes the PR body there as `pr-body.md` (Phase 7).
- Base = `main` at the freshly fetched `FETCH_HEAD`; record `base <sha>` in the row's notes.
- Update the state row at each milestone: `built` after the first commit, `pushed` + PR URL right after Gate C.
- PR body: the first `### What` bullet is `Part <n>/<total> of <plan title>: <one line>`. Do not link PRs that do not exist yet.
- On a `built`/`pushed` resume, run ship-feature **Phase 4a** only if no live server is already running from this worktree. Check that the PID in `.plans/dev.pid` is alive and that `readlink /proc/<pid>/cwd` lies inside `.worktrees/<slug>`.
- Everything else is inherited unchanged.

### Phase 4a — Restart the dev server from this worktree

Follow `ship-feature.md` **Phase 4a** as written. It stops the previous server from `.plans/dev.pid`, frees `:3000`, starts the server detached with `setsid` from `.worktrees/<slug>`, records the PID and prints the `Dev:` URL. The next PR's run replaces the server.

## Phase 5 — Automated review wait + PR feedback

Follow `ship-feature.md` **Phases 8–9 verbatim** (bounded polling for the Copilot review, paginated fetch, triage table, fixes + quality gates, Gate D push, Gate E replies and resolving fix-landed threads), with one override for the wait:

- **Stop polling as soon as Copilot has posted.** The only automated reviewer in this repo is `copilot-pull-request-reviewer[bot]`, which posts one review (state `COMMENTED` or `APPROVED`) with its inline comments attached, usually within two to three minutes. Poll with a background `sleep 30` instead of `sleep 60`; after each wake fetch `gh api repos/<owner>/<repo>/pulls/<PR>/reviews` and stop as soon as a review by that login exists and the review-comment count has not changed since the previous wake. Keep the 10-minute cap and the "no automated review within <max>" message.

## Phase 6 — Hand-off

1. Update the state row (`pushed`, PR URL, last fix SHA) and `last-run`.
2. Print: `State: .plans/<plan-slug>/state.md`; `Dev: http://localhost:3000/` (or that it is not running); worktrees removed in Phase 1b; the refreshed table; this PR's URL; findings (self vs Codex) and fixes applied; PR comments triaged/fixed/replied/resolved; quality-gate status; the next PR id and title; and a note that `.worktrees/<slug>` stays until its PR is merged, when the next run removes it (Phase 1b). Never remove it now, never delete the branch now.
3. End with:
   ```
   Merge PR #<n>, then run /ship-plan <plan path> again (a fresh session is fine).
   ```
   With `--continue`: poll for the merge as in Phase 1 and, once `merged`, go back to Phase 1 in the same session. Mention once that the default (one PR per run) is recommended because each run then starts with an empty context and compaction never lands mid-build.

When Phase 1 finds every PR `merged`, print `Plan complete.` with the final table and stop. Leave the plan folder in place; the user deletes it.
