---
description: Grill the user into a plan split into PR-sized slices, Codex-review the plan once, then publish it to GitHub as one epic issue + one sub-issue per PR (labelled ready-for-agent) for /ship-issue to pick up
argument-hint: '[feature description | path/to/plan.md]'
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Task, TodoWrite, AskUserQuestion, Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(node:*), Bash(ls:*), Bash(mkdir:*), Bash(cat:*), Bash(head:*), Bash(tail:*), Bash(grep:*), Bash(sed:*), Bash(sort:*), Bash(gitleaks:*), Bash(docker:*)
---

Turn an idea (or an existing plan) into GitHub issues that `/ship-issue` can ship one at a time: explore the code → interview the user in **grilling rounds** until nothing is silently assumed → write a plan split into PR-sized vertical slices → Codex-review the whole plan once → scan the issue bodies for anything sensitive → publish one **epic** issue plus one **sub-issue per PR**, each labelled `ready-for-agent`.

**Relationship to the other commands.** `/ship-plan` ships a local plan file; this command puts the same kind of plan on GitHub instead, and `/ship-issue` ships it from there. The whole-plan Codex review happens **here**, so `/ship-issue` only reviews the per-issue spec. GitHub is the state: there is no state file, only a local record of what was created so a failed publish can be resumed.

**Hard rules** (inherited from `~/.claude/commands/ship-feature.md`): emit `gh`/`git` commands that start with the tool name, with literal values inlined, no `$(…)`, no leading `VAR=` assignments; change files only with the Edit and Write tools; pass bodies with `--body-file`, never `--body "$(cat …)"`. Nothing leaves the machine before the Phase 5 gate.

**Retro notes.** Follow ship-feature's **Retro notes** section, with `<unit>` = `<folder>` once it exists (before that, `<repo-root>/.plans/`). Extra events here: a grilling round whose answer overrode your recommendation, a Phase 3 split change, a Phase 4b scan hit, a Phase 5 retry or `publication incomplete`. At the end (after the step 6 print, or before any STOP), the summary covers: grilling rounds used, split changes, Codex whole-plan findings applied vs rejected (one line per applied finding), scan hits, publish retries.

Arguments: `$ARGUMENTS` — a feature description, or a path to an existing plan file. Both optional.

## Phase 0 — Pre-flight (read-only)

1. `gh auth status` must succeed, else STOP (`gh auth login`). A fine-grained PAT needs **Issues: Read and write** on this repo (creating, editing, labelling and linking issues all need it) plus Metadata: Read. Creating can succeed while editing fails if the permission is narrower than that, which is why Phase 5 checks write access right after the epic exists.
2. `gh repo view --json owner,name,visibility` → `<owner>`, `<repo>`, `<visibility>`. Remember the visibility: it is printed at the publish gate.
3. `mkdir -p <repo-root>/.plans`; if `git -C <repo-root> check-ignore .plans` does not match, append `.plans/` to `<repo-root>/.git/info/exclude` (local only, never committed; not under `.claude/` because Claude Code prompts on every write there).

## Phase 1 — Gather + explore

**Source**, in order: a `*.md` path in `$ARGUMENTS` (read it in full); a plan already agreed in this chat; the rest of `$ARGUMENTS` as a one-line description; else ask what to build.

Before asking the user anything, **explore the codebase** with Explore subagents (read `AGENTS.md`, the areas the feature touches, existing patterns to reuse, CI gates). Facts about the repo are your job to find, never the user's. Keep the findings; they feed the questions and the plan.

## Phase 2 — Grill (rounds)

Interview the user until you share one understanding. Treat the design as a **tree**: every decision branches into the decisions that hang off it. The **frontier** is every question whose prerequisites are already settled. Ask the whole frontier in one round, then wait.

- **Format.** Number the questions and give a recommended answer for each, worded so that "yes" accepts your recommendation. Put the decisions to the user with `AskUserQuestion` (at most 4 questions per call, the recommended option first and marked `(Recommended)`; use several calls when a round has more). Show your reasoning for the recommendation in one line in the option description.
- **Facts vs decisions.** When a question needs a fact from the environment, look it up (subagent) instead of asking; only questions downstream of a running lookup wait for it. Decisions are the user's.
- **Branches to visit every time:** goal and non-goals; constraints and non-negotiables (security, data, platforms, dependencies); acceptance, i.e. how we will know it is done; the PR split and its order; what is explicitly deferred.
- **Rounds.** Recompute the frontier after each answer set. A question whose answer depends on a still-open question belongs to a later round. Stop when the frontier is empty, with a hard cap of four rounds; when the source was an existing plan, do **one** round on its gaps only.
- **Close.** Write a one-paragraph shared understanding (goal, key decisions, out of scope) and confirm it with one `AskUserQuestion` (`Is this our shared understanding?`: `Yes, write the plan (Recommended)` / `Not yet`). Do not write anything before the yes.

## Phase 3 — Write the plan (local file)

Every file this command writes lives in one **plan folder**, `<folder>` = `<repo-root>/.plans/<plan-slug>` (absolute, no trailing slash). The layout, the `<plan-slug>` rule (from the `# title`, never the file name) and the collision rule are defined once in `~/.claude/commands/ship-plan.md` Phase 0 step 3; follow them. If the source is already `.plans/<x>/plan.md`, `<folder>` is `.plans/<x>/` and you rewrite that `plan.md` in place. Otherwise `mkdir -p <folder>/prs`, and when the source was a file outside `.plans/`, record its path as `source:` in `<folder>/issues.md` (create the record now if needed).

Write `<folder>/plan.md` with the Write tool. Shape, the same one `/ship-plan` parses:

```
# <Plan title>

## Context
<goal, decisions table, standing rules that apply to every PR, non-goals>

## PR 1 — <title>
**Delivers:** <the end-to-end behaviour a user can see or verify when this lands>
**Blocked by:** None | PR <n>
**Design:** …
**Files:** …
**Tests:** …
**Acceptance:**
- [ ] …

## PR 2 — <title>
…

## Order and dependencies
<the decided order and why>

## Deferred
<what was consciously left out>
```

**Split rules** (vertical slices, not layers):

- Each PR cuts a narrow but complete path through every layer it needs and is demoable or verifiable on its own; it is green on CI by itself.
- Each PR fits one fresh context window of `/ship-issue` work. If it would not, split it.
- Prefactoring that makes later PRs easy comes first ("make the change easy, then make the easy change").
- A wide mechanical refactor (rename a shared symbol, retype a column) is the exception: sequence it as expand → migrate in batches → contract, each step its own PR, so CI stays green between them.
- Later PRs may be sketches; `/ship-issue` re-plans each one against `main` right before building it. Earlier PRs should be concrete.

Then print a numbered table (`#`, title, blocked by, delivers) and ask one granularity question with `AskUserQuestion` (`Does the split look right?`: `Yes (Recommended)` / `Merge or split some` / `Edit the plan`). On anything but yes, apply the change to the file and re-ask.

## Phase 4 — Whole-plan Codex review

Run the whole-plan review from `~/.claude/commands/ship-plan.md` **Phase 2** on the plan file: resolve the companion with `ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null` (highest version; if none, print `Codex companion not found — skipping plan review (run /codex:setup to enable)` and go on), then run `node "<resolved-absolute-path>" task --model gpt-6-sol '<the ship-plan Phase 2 prompt, verbatim, with <PATH> = the plan file>'` in the foreground, path inlined as a literal, prompt single-quoted.

Triage: fold every **valid** finding into the plan file (Edit tool) under the PR it belongs to; list **rejected** findings with a one-line reason. Print a short recap (verdict, raised, applied, rejected). No gate; the plan was approved in Phase 3.

## Phase 4b — Issue bodies + sensitive-content guard

Issues on a public repo are world-readable the moment they exist, and this one is `<visibility>` from Phase 0. So the bodies are files first, scanned, and shown before anything is posted.

**Content rules.** Issue bodies are derived from the plan text only. Never paste tool output, file contents, logs, stack traces, env-var values, hostnames, internal URLs, customer or colleague names, or the user's email. Paths are repo-relative (never `/home/<user>/…`). No credentials of any kind, not even example ones.

1. **Write the bodies** with the Write tool: `<folder>/epic.md`, and `<folder>/prs/<id>/issue.md` per PR (`<id>` from its `## PR <id> —` heading; `mkdir -p` each unit folder). Generate titles and bodies from the plan file **as it stands now**, after Phase 4 and after any decision made during its triage; if anything in the plan changes later (at the gate, for instance), regenerate the affected files before publishing. Titles are final once an issue exists: the publish step never retitles.

   Epic body:
   ```
   ## Goal
   <from Context>

   ## Decisions
   <table from Context>

   ## Standing rules
   <rules every PR follows>

   ## PRs
   - PR 1 — <title>      (rewritten to `- #<n> <title>` after the children exist)
   - PR 2 — <title>

   ## Deferred
   <from Deferred>
   ```

   `## PRs` is a plain list for humans, not a checklist: progress is tracked by the native sub-issues and the plan's milestone, and nothing ticks this list.

   Child body:
   ```
   Part of #<epic>            (written as `Part of #EPIC` now, filled in at publish time)

   ## What to build
   <Delivers: end-to-end behaviour from the user's perspective, not a layer list>

   ## Acceptance criteria
   - [ ] …

   ## Blocked by
   - #<n> <title>  |  None (can start immediately)      (numbers filled in at publish time)

   ## Implementation notes
   <this PR's Design / Files / Tests. File paths are allowed here; /ship-issue re-checks them against main>
   ```

2. **Scan the bodies.**
   - gitleaks directory mode, run twice, on `<folder>/epic.md` and on `<folder>/prs`: if `gitleaks dir --help` works, `gitleaks dir --redact --no-banner <path>`; else, if `docker info` works, `docker run --rm -v <folder>:<folder>:ro ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f dir --redact --no-banner <path>` (the same pinned image as `tooling/github/scripts/secrets-scan.sh`); if neither is available, say so once and continue. Exit 1 = findings: **STOP** until they are removed from the files.
   - Heuristic grep, one call: `grep -nEi '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|/home/|C:\\Users|([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|passwd|password|secret|token|api[_-]?key|bearer|BEGIN .*PRIVATE KEY' <folder>/epic.md <folder>/prs/*/issue.md`. Drop hits that are `127.0.0.1` or `https://github.com/` and list the rest as `file:line: text`. Each remaining hit is either edited out or explicitly accepted at the gate.

3. Show every body in full (the user may also read the files in the editor) and the scan result (`Scan: clean` or the hit list).

## Phase 5 — Publish (gate)

**Gate.** `AskUserQuestion`, question text starting with `This repo is <VISIBILITY> (<owner>/<repo>). <N> issue bodies in .plans/<plan-slug>/ will be posted. Scan: <clean | hits>. Create these issues?` Options: `Create issues (Recommended)` / `Edit bodies first` / `Cancel`. On `Edit bodies first`, apply the edits to the files with Edit, re-run the Phase 4b scan, re-ask. On `Cancel`, stop; the files stay for a later run.

**Idempotent and resumable.** Publishing is several network calls and any one can fail, so the whole phase must be safe to run twice:

- **Resume from the local record first.** If `<folder>/issues.md` has an `epic:` line, it is the map: its `epic:` line and its `| PR | issue | … |` rows name the issues that already exist, by number. Verify each with `gh issue view <number> --json number,title,state` and reuse it whatever its current title is (titles may have drifted; never retitle, never create a second issue for a PR that has a number in the record). Only when there is no record, fall back to `gh issue list --state open --limit 200 --search "<plan title> in:title" --json number,title` for the epic and `gh api repos/<owner>/<repo>/issues/<epic>/sub_issues --jq '.[] | [.number, .title] | @tsv'` for the children, matched by exact title. Either way, create only the PRs that have no issue, then repair relationships: add the missing parent links and the missing blocked-by edges (`gh api repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by --jq '.[].number'` shows the existing ones), set the milestone on any recorded issue that lacks it (`gh issue edit <n> --milestone "<plan title>"`), rewrite the `## PRs` list, label last.
- Keep the local record `<folder>/issues.md` (Write/Edit): `plan:` (the absolute path of `<folder>/plan.md`), `source:` when there is one, the `milestone:` number, the epic number, and a `| PR | issue | id | parent | blocked-by edges | milestone | labelled |` table updated after every call, so a failed run can always be resumed by number.
- The `ready-for-agent` label goes on **last**, only when every child exists, is linked to the epic and has all its blocked-by edges, so `/ship-issue` can never pick up a half-published plan.

Steps:

1. **Label.** `gh label list --search ready-for-agent --json name`; if missing, `gh label create ready-for-agent --description "Ready for /ship-issue" --color 0E8A16`.
   **Milestone**, one per plan, titled exactly like the epic (`<plan title>`). If `issues.md` has a `milestone:` line, reuse that number. Otherwise list `gh api --paginate 'repos/<owner>/<repo>/milestones?state=all' --jq '.[] | [.number, .title] | @tsv'` and match the title exactly in the output (never put the title inside the jq filter: a `"` or `\` in it would break the filter). Found but not in the record → `AskUserQuestion` (`Milestone #<m> "<plan title>" already exists. Reuse it?`): `Reuse milestone #<m>` / `Cancel`. Not found → `gh api --method POST repos/<owner>/<repo>/milestones -f title="<plan title>" --jq .number`. Record `milestone: <m>`.
2. **Epic.** `gh issue create --title "<plan title>" --milestone "<plan title>" --body-file <folder>/epic.md` → `<epic>`. No label. Record it.
   **Write check, before any child exists:** `gh api --method PATCH repos/<owner>/<repo>/issues/<epic> --jq .number -F body=@<folder>/epic.md` (a no-op: same body). A 403 `Resource not accessible by personal access token` means the token can create but not edit; STOP here with `Token lacks Issues: Read and write; fix it at github.com/settings/personal-access-tokens, then run /plan-to-issues <plan path> again (epic #<epic> is recorded and will be reused).` One issue to reuse, not six to repair.
3. **Children, in dependency order** so blockers already have numbers. For each: fill `Part of #<epic>` and the `## Blocked by` numbers in the file with Edit, then `gh issue create --title "<title>" --milestone "<plan title>" --body-file <folder>/prs/<id>/issue.md` → `<child>`. Record it. Then set two kinds of native **Relationships**, both keyed by the numeric issue id (`gh api repos/<owner>/<repo>/issues/<child> --jq .id`, standalone call; keep every id in the local record so blockers need no second lookup):
   - **Parent:** `gh api --method POST repos/<owner>/<repo>/issues/<epic>/sub_issues -F sub_issue_id=<child id>`.
   - **Blocked by:** for each blocker in the child's `## Blocked by`, `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker id>`. Children are created in dependency order, so every blocker already has an id. GitHub then shows the child as blocked in its Relationships box and `/ship-issue` reads the edges from the API; the body text stays as the human-readable fallback.

   If a call fails, retry it once; if it still fails, record `parent: no` or the missing edge and continue with the next child.
4. **PR list.** Edit `<folder>/epic.md` so `## PRs` reads `- #<child> <title>` per PR (no checkboxes), then `gh api --method PATCH repos/<owner>/<repo>/issues/<epic> -F body=@<folder>/epic.md --jq .number`. This is the only edit of an existing issue the command makes; it never changes a title.
5. **Label the children** only if every child exists, has its parent link, has every blocked-by edge and is in the milestone: `gh api --method POST repos/<owner>/<repo>/issues/<child>/labels -f 'labels[]=ready-for-agent' --jq '.[].name'` each. Otherwise STOP and report **publication incomplete** with the missing links or edges and `Run /plan-to-issues <folder>/plan.md again to repair.` Never report success with missing relationships.
6. Write the final retro notes to `<folder>/retro/<session-id>.md`. Print the epic URL, the milestone URL (`https://github.com/<owner>/<repo>/milestone/<m>`) and the table of children (`#`, title, blocked by, URL), then end with:
   ```
   Run /ship-issue <first child with no blockers> to start.
   ```
