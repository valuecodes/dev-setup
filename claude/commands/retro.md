---
description: Retrospective on a shipped epic, plan or session — gather retro notes, PR feedback and transcripts, then propose ranked improvements to the agent's environment (checks, reviewer rules, steering files, commands, permissions) and apply the ones you pick
argument-hint: "[plan folder | epic number | session id]"
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Task, TodoWrite, AskUserQuestion, Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(grep:*), Bash(head:*), Bash(tail:*), Bash(wc:*), Bash(sort:*), Bash(uniq:*), Bash(mkdir:*)
---

Run a **retrospective** and suggest improvements to the coding agent's **environment** so future `/plan-to-issues`, `/ship-issue`, `/ship-plan` and `/ship-feature` runs go better. Not the product code: the checks, reviewer rules, steering files, commands, permissions and information the agent works with.

Inspired by Matt Pocock's `retro` skill and tailored to this pipeline: evidence comes from the per-session **retro notes** the ship commands write (defined once in `~/.claude/commands/ship-feature.md`, section **Retro notes**), the plan folder, GitHub PR feedback and the session transcripts.

**Hard rules.** Read-only toward GitHub: only `gh` GET calls and `gh pr view` / `gh pr checks` / `gh issue view`, never POST, PATCH, comment, close or label. Emit `gh`/`git` commands that start with the tool name with literals inlined, no `$(…)`, no leading `VAR=`. Change files only with Edit and Write. Never edit repo-tracked files (they go through `/ship-feature` as a PR, Phase 3). Never quote prompt, reply or code text from transcripts in any file this command writes.

Arguments: `$ARGUMENTS`: a plan folder (`.plans/<slug>`), an epic number (`#12` or `12`), a session id (UUID), or nothing.

## Phase 0 — Scope

1. **Plan folder** given → epic/plan retro over that folder.
2. **Epic number** → `grep -lE '^epic: *#?<n>\b' .plans/*/issues.md`; one match → that folder; none → an epic retro from GitHub only (no plan folder; write output to `.plans/epic-<n>/`).
3. **Session id** → session retro over `~/.claude/projects/<project>/<id>.jsonl` (`<project>` = the repo root path with every `/` turned into `-`). Output goes to `.plans/retro/<id>/`.
4. **Nothing** → the current session (the one this command runs in, id from the scratchpad path), as upstream does. But if `ls -t .plans/*/retro-summary.md` shows plan folders with `retro/` notes newer than their last summary (or with notes and no summary), first `AskUserQuestion` (`What should this retro cover?`): `This session (Recommended)` / `.plans/<newest such folder>` / up to two more folders.

`<out>` = the plan folder, or the session output folder above. `mkdir -p <out>`.

Read `<out>/retro-summary.md` if it exists: its rejected candidates are not proposed again unless new evidence changes the case (say so when it does).

## Phase 1 — Gather (read-only)

Seed `TodoWrite` with the sources below. Fan out with `Task` subagents (Explore) where a source is large; they return facts and counts, never raw transcript text.

1. **Retro notes.** Every `<out>/retro/*.md` and `<out>/prs/*/retro/*.md`. Several files for one unit are separate sessions of the same issue: read them all. Collect their `session:` ids.
2. **Plan vs reality** (plan folder only). `plan.md` against each `prs/*/spec.md`: what the re-plan added, removed or corrected. `issues.md` / `state.md`: order shipped, closed-unshipped issues, retries.
3. **GitHub, per PR** (from `issues.md`, `state.md`, or `gh pr list --state all --search "Closes #<n> in:body"` per child issue): `gh api --paginate repos/<owner>/<repo>/pulls/<pr>/comments --jq '.[] | [.user.login, .path, .line, .body] | @tsv'` (Copilot and human review comments), `gh pr view <pr> --json commits,reviews,statusCheckRollup` (fix-commit count, failed checks). Classify each review comment as valid / noise using the replies the ship run posted (`Fixed in <sha>` = valid).
4. **Transcripts.** One Explore subagent per up to three session ids (fallback when a unit has no notes: `grep -l 'feat/<n>-' ~/.claude/projects/<project>/*.jsonl`). Ask it to inspect the JSONL structure first (`head -c 2000`), then report counts only: tool calls by tool name; permission prompts and denials, with the command shape (first word plus flags, no values); the 5 largest tool results by size, with tool and command shape; searches repeated for the same thing; compactions; time between first and last message. No message text.
5. **Steering and guardrails as they are now.** Repo: `AGENTS.md` (size in lines), `CLAUDE.local.md`, `.oxlintrc.json`, `knip.jsonc`, root `package.json` scripts, `.github/workflows/*.yml` (what CI actually runs), `CODING_STANDARDS.md` if present. User: `~/.claude/commands/{plan-to-issues,ship-issue,ship-plan,ship-feature}.md`, `.claude/settings.json` permissions, memory index. A check that exists but is unwired or skipped is a finding, not a reason to add a new one.

## Phase 2 — Candidates

Go through each category; a category needs evidence from Phase 1 to produce a candidate. Upstream's seven, then two for this pipeline:

| Category               | Use when                                                                                                                       | Typical target                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Navigation**         | Finding a file or fact took long; hidden coupling between files                                                                | A pointer in `AGENTS.md`, or a doc it points to                                                                                                             |
| **Automated checks**   | A mistake an automated check could have caught; a check that is missing from CI or silently broken                             | oxlint rule in `.oxlintrc.json`, knip config, CI job, test, clippy lint                                                                                     |
| **Coding standards**   | Review (self / Codex / Copilot) caught something the build should not have produced, or missed something                       | Mechanical → a deterministic check (row above), always the default. Judgement → a reviewer rule in `CODING_STANDARDS.md`, read by `ship-feature.md` Phase 5 |
| **AGENTS.md size**     | Steering that belongs in a check or reviewer rule instead                                                                      | Move out of `AGENTS.md`                                                                                                                                     |
| **Tool economy**       | Large or repeated tool output, expensive calls                                                                                 | Command instructions (`                                                                                                                                     | tail`, narrower queries), scripts |
| **No-ops**             | Steering lines that change no behaviour                                                                                        | Delete them                                                                                                                                                 |
| **Information access** | The agent lacked a log, state or service it needed                                                                             | Dev-server log tee, read-only access, a command step                                                                                                        |
| **Plan quality**       | Spec drift at re-plan; slices too big, wrongly ordered or blocked; a standing rule the epic lacked                             | `plan-to-issues.md` grilling branches or split rules                                                                                                        |
| **Command friction**   | Permission prompts, gate loops, `$(…)` or shell shapes the allowlist misses, STOPs that a pre-flight could have caught earlier | `~/.claude/commands/*.md`, `.claude/settings.json`, `CLAUDE.local.md`                                                                                       |

**Implementation vs review.** The implementing agent has the most context pressure; the reviewer gets a diff. So standards are imposed at review (`ship-feature.md` Phase 5 and its Codex review), not added to `AGENTS.md`, which every implementer pays for. `AGENTS.md` stays sparse: navigation pointers and invariants. If no `CODING_STANDARDS.md` exists, the first judgement-rule candidate proposes creating it _and_ wiring Phase 5 to read it and pass it to the Codex review; never create it otherwise.

Each candidate, terse and imperative:

```
<n>. [<severity>] <category> — <one-line change>
   Evidence: <issue/PR/session> — <one-line fact> (×<occurrences>)
   Change:   <target file> — <what exactly; mechanical | judgement>
   Effect:   <what stops happening>
```

Severity: **High** = repeated (≥2 occurrences) or cost a STOP, a CI failure on a PR or a review round trip; **Medium** = once, costly; **Low** = friction. Sort High first. Then a short **Keep doing** list (what worked; at most 5 lines). Print everything.

## Phase 3 — Pick and apply (gate)

`AskUserQuestion`, `multiSelect: true`, `Apply which candidates?`: one option per candidate (label `<n>. <short change>`, description = evidence + target), at most 4 per call, several calls in severity order. Unpicked candidates are recorded as deferred unless the user rejects them in their answer (`Other` text), which records them as rejected with the reason.

Apply each picked candidate by target:

- **User-scope files** (`~/.claude/commands/*.md`, `CLAUDE.local.md`, memory files):
  1. **Backup:** Read the file and Write an exact copy to `<out>/retro-backups/<file name>` (add `-2`, `-3` if one exists) before the first Edit.
  2. Apply with Edit.
  3. **Validate:** Read the file back. A command file must still start with a `---` frontmatter block that closes, with `description`, `allowed-tools` and `disable-model-invocation` present. Compare `grep -c 'Gate'`, `grep -c 'AskUserQuestion'` and `grep -ci 'never'` between the backup and the new file: a lower count fails unless removing that line is the candidate. Memory files keep their frontmatter and their `MEMORY.md` pointer. Show a short before/after excerpt.
  4. **On failure:** Write the backup back over the file and mark the candidate `failed validation`.
- **Repo-tracked files** (`AGENTS.md`, `.oxlintrc.json`, `knip.jsonc`, CI workflows, `CODING_STANDARDS.md`, tests, scripts): do not edit. Append each to `<out>/retro-plan.md`, a plan `/ship-feature` can build directly: `# Retro fixes: <scope>`, `## Context` (why, with the evidence lines), then one `## Step <k> — <title>` per candidate with **Files**, **Change**, **Tests / verification**. Print `Run /ship-feature <absolute path of retro-plan.md> to ship these as a PR.`
- **`.claude/settings.json` permissions**: do not edit; print the exact rule and say to add it with `/update-config` (or run `/fewer-permission-prompts`).

## Phase 4 — Record

Write `<out>/retro-summary.md`:

```
# Retro: <scope> (<date>)
sources: <n> retro notes, <n> PRs, <n> transcripts

| # | severity | category | change | target | status | backup |
status ∈ applied | deferred | rejected (<reason>) | failed validation | in retro-plan.md

## Keep doing
- …
```

If the file exists, add a new dated section on top; keep earlier ones (their rejected rows are what Phase 0 reads).

Print: applied, with backup paths for rollback; failed validation; the `retro-plan.md` hint if any; deferred count. End with `Retro saved to <out>/retro-summary.md.`
