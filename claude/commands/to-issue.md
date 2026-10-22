---
description: Turn one bug or small idea into a single ready-for-agent GitHub issue for /ship-issue — explore, one short clarify round, scan the body, publish (optionally under an existing epic). No epic, no Codex review; /ship-issue reviews the spec when it ships
argument-hint: '<description> [--epic <n>] [--blocked-by <n>[,<n>]]'
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Task, TodoWrite, AskUserQuestion, Bash(git:*), Bash(gh:*), Bash(ls:*), Bash(mkdir:*), Bash(cat:*), Bash(head:*), Bash(tail:*), Bash(grep:*), Bash(gitleaks:*), Bash(docker:*)
---

The light version of `/plan-to-issues` for work that fits **one PR**: explore the code → one clarify round → draft one issue body → scan it → publish it with the `ready-for-agent` label so `/ship-issue` can pick it up. When the work needs more than one PR, STOP and say `Run /plan-to-issues instead.`

**Relationship to the other commands.** `/plan-to-issues` makes an epic plus sub-issues and Codex-reviews the plan; this command makes one issue and skips both. `/ship-issue` re-plans the issue against `main` and Codex-reviews that spec, so nothing is lost by skipping the review here. Issue body format, labels and relationships are the ones `/ship-issue` reads.

**Hard rules** (from `~/.claude/commands/ship-feature.md`): `gh`/`git` commands start with the tool name, literals inlined, no `$(…)`, no leading `VAR=`; files change only through Edit and Write; bodies go through `--body-file`. Nothing leaves the machine before the Phase 3 gate. **Retro notes:** follow ship-feature's **Retro notes** section with `<unit>` = `<draft>` (Phase 2), events as there plus a scan hit or a publish retry; summary at the end.

Arguments: `$ARGUMENTS` — a description (required; ask if missing), optional `--epic <n>` (make the issue a sub-issue of that epic and put it in the epic's milestone), optional `--blocked-by <n>[,<n>]`.

## Phase 0 — Pre-flight (read-only)

1. `gh auth status` must succeed, else STOP (`gh auth login`; the token needs Issues: Read and write).
2. `gh repo view --json owner,name,visibility` → `<owner>`, `<repo>`, `<visibility>`.
3. If `--epic` is given: `gh issue view <epic> --json number,title,state,milestone`. It must be open; STOP otherwise. Keep its milestone title. Read its body's `## Standing rules` and `## Decisions`: they apply to this issue.
4. If `--blocked-by` is given: `gh issue view <n> --json number,title,state` for each; warn on closed ones (closed is not delivered; `/ship-issue` will check).
5. `mkdir -p <repo-root>/.plans`; if `git -C <repo-root> check-ignore .plans` does not match, append `.plans/` to `<repo-root>/.git/info/exclude`.

## Phase 1 — Explore + one clarify round

1. **Explore** the code the description touches with Explore subagents (`AGENTS.md`, the files involved, existing patterns, tests, the CI gates). Facts are your job, not the user's. Keep the findings.
2. **Size check.** If the change needs more than one PR to stay green on CI and demoable, STOP with `This needs <n> PRs: run /plan-to-issues "<description>" instead.`
3. **One round** of `AskUserQuestion` (at most 4 questions, recommended option first and marked `(Recommended)`, the reasoning in one line in the description). Cover only what is genuinely open after exploring: scope boundary, acceptance, a constraint (security invariants, data, dependencies), what is deferred. Skip questions the code already answers. Then write a two-line shared understanding and confirm it in the same call or a second one (`Is this it?`: `Yes, draft the issue (Recommended)` / `Not yet`). On `Not yet`, one more round, then draft.

## Phase 2 — Draft + scan

`<slug>` = the issue title, lowercased, non-alphanumerics to `-`, trimmed, at most 50 chars. `<draft>` = `<repo-root>/.plans/to-issue/<slug>/`; `mkdir -p <draft>`.

If `<draft>/issue.md` already ends with a `created: #<n>` line, an earlier run published it: do not rewrite the draft (that would drop the marker and create a duplicate). Go straight to the Phase 3 resume check.

1. Write `<draft>/issue.md` with the Write tool. Shape (the one `/ship-issue` parses):

   ```
   Part of #<epic>                       (only with --epic)

   ## What to build
   <end-to-end behaviour from the user's perspective, 2–6 lines>

   ## Acceptance criteria
   - [ ] …

   ## Blocked by
   - #<n> <title>  |  None (can start immediately)

   ## Implementation notes
   <design, repo-relative files, tests; what /ship-issue should re-check against main>

   ## Deferred
   <what was consciously left out, or "Nothing">
   ```

   Title: plain English, capitalized, ≤72 chars, no trailing period.

   **Content rules.** Derived from the exploration and the answers only. No tool output, logs, stack traces, env values, hostnames, internal URLs, names or emails. Paths repo-relative, never `/home/<user>/…`. No credentials, not even examples.
2. **Scan.** gitleaks on the draft: `gitleaks dir --redact --no-banner <draft>` if `gitleaks dir --help` works; else, if `docker info` works, `docker run --rm -v <draft>:<draft>:ro ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f dir --redact --no-banner <draft>`; else say so once. Exit 1 = findings: **STOP** until removed. Then `grep -nEi '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|/home/|C:\\Users|([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|passwd|password|secret|token|api[_-]?key|bearer|BEGIN .*PRIVATE KEY' <draft>/issue.md`; drop `127.0.0.1` and `https://github.com/` hits; list the rest as `line: text`.
3. Show the title, the body in full, and `Scan: clean` or the hit list.

## Phase 3 — Publish (gate)

**Gate.** `AskUserQuestion`, question text starting with `This repo is <VISIBILITY> (<owner>/<repo>). One issue from .plans/to-issue/<slug>/ will be posted<, as a sub-issue of #<epic>>. Scan: <clean | hits>. Create it?` Options: `Create issue (Recommended)` / `Edit body first` / `Cancel`. On `Edit body first`, apply the edits with Edit, re-run the scan, re-ask. On `Cancel`, stop; the draft stays.

Steps, each safe to repeat:

1. **Label.** `gh label list --search ready-for-agent --json name`; if missing, `gh label create ready-for-agent --description "Ready for /ship-issue" --color 0E8A16`.
2. **Resume check.** If `<draft>/issue.md` already has a `created: #<n>` line at the end (added in step 3), `gh issue view <n> --json number,state` and reuse it; never create a second one.
3. **Create.** `gh issue create --title "<title>" --body-file <draft>/issue.md` plus `--milestone "<epic milestone title>"` when the epic has one → `<n>`. Append `created: #<n>` to `<draft>/issue.md` with Edit (it is below the body GitHub already has; it is never posted).
4. **Relationships** (numeric ids: `gh api repos/<owner>/<repo>/issues/<n> --jq .id`, one standalone call per issue):
   - with `--epic`: `gh api --method POST repos/<owner>/<repo>/issues/<epic>/sub_issues -F sub_issue_id=<issue id>`;
   - per blocker: `gh api --method POST repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by -F issue_id=<blocker id>`.
   Retry a failed call once; if it still fails, report it and continue (the body text is the fallback `/ship-issue` reads).
5. **Label last**, only once the relationships are in place: `gh api --method POST repos/<owner>/<repo>/issues/<n>/labels -f 'labels[]=ready-for-agent' --jq '.[].name'`. If a relationship is missing, STOP with `publication incomplete` and `Run /to-issue again to repair` (the `created:` line makes it resume).
6. **Unit folder.** `mkdir -p <repo-root>/.plans/issue-<n>` and Write a copy of the body to `.plans/issue-<n>/issue.md`: that is where `/ship-issue` keeps this issue's spec, PR body and retro notes. Write the retro summary to `.plans/issue-<n>/retro/<session-id>.md`.
7. Print the issue URL and end with:
   ```
   Run /ship-issue <n> to start.
   ```
