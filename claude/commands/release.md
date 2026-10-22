---
description: Cut a GitHub Release of everything merged to main since the last release — CI-gated, semver suggested from conventional commits, GitHub-generated notes regrouped by type — tag + release only, no commits
argument-hint: "[vX.Y.Z[-pre]] [--draft] [--prerelease]"
disable-model-invocation: true
allowed-tools: Read, Write, AskUserQuestion, Bash(git:*), Bash(gh:*), Bash(mkdir:*), Bash(grep:*), Bash(gitleaks:*), Bash(docker:*)
---

Publish **one GitHub Release per run** of whatever is on remote `main` since the previous release: pre-flight + CI gate on the exact target SHA → find the baseline (and reconcile any draft) → suggest a semver bump → generate notes with GitHub and regroup them → **gate** → publish. Then print the release URL.

**Relationship to the other commands.** `/plan-to-issues` → `/ship-issue` get work merged. Releasing is a separate, deliberate step: one release may bundle several epics. `/ship-issue` only prints a hint when a milestone closes; it never releases.

**The tag is the version.** No file in the repo carries the version (`package.json` stays `0.0.0`), so a release never commits to `main` and never opens a PR. `gh release create --target <sha>` creates the tag on the server, so nothing is pushed from this machine.

**Hard rules** (inherited from `~/.claude/commands/ship-feature.md`): emit `gh`/`git` commands that start with the tool name, with literal values inlined, no `$(…)`, no leading `VAR=` assignments; network git goes over the HTTPS URL via the gh token, never the SSH `origin`; change files only with the Write tool; pass notes with `--notes-file`, never `--notes "$(cat …)"`. Nothing leaves the machine before the Phase 4 gate. Never delete a published release or tag. The only deletion this command does is a draft, and only after the user picks that option.

Arguments: `$ARGUMENTS` — an optional version (`vX.Y.Z` or `vX.Y.Z-pre`; wins over the suggestion), optional `--draft` (preselect "Publish as draft" at the gate), optional `--prerelease` (mark the release as a prerelease even without a `-pre` suffix).

## Phase 0 — Pre-flight + CI gate (read-only)

1. `gh repo view --json url,owner,name,defaultBranchRef` → `<https-url>` (url + `.git`), `<owner>`, `<repo>`. If the default branch is not `main`, STOP and report it.
2. `git ls-remote <https-url> HEAD`: if it prompts or fails, STOP with the fix (gh credential helper).
3. `git fetch <https-url> main --tags`, then `git rev-parse FETCH_HEAD` → `<sha>`. **The target is always `<sha>` (remote main)**, never the local branch or working tree. Local changes are irrelevant and are not mentioned.
4. **CI gate on that exact SHA:** `gh run list --commit <sha> --branch main --workflow main.yml --json databaseId,status,conclusion,url`.
   - Judge only the newest run (the first in the list; a rerun of an older attempt does not count). It has `status: completed` and `conclusion: success` → pass.
   - No run, a newest run still `queued`/`in_progress`, or any other conclusion (`failure`, `cancelled`, …) → STOP: `CI has not passed on <short-sha> (<state>, <url>); wait for it or fix main, then run /release again.` There is no override: a release must point at a commit that passed CI. (`main.yml` cancels in-progress runs when main moves, so a `cancelled` run usually means a newer commit exists. Rerunning `/release` picks up the newer commit.)

## Phase 1 — Baseline + draft reconcile

1. **Drafts first:** `gh release list --limit 100 --json tagName,name,isDraft,isPrerelease,publishedAt,createdAt`. For each draft, ask (AskUserQuestion) per draft:
   - **Resume** → remember `<draft-tag>`. Later phases reuse it: the version is fixed to `<draft-tag>` (Phase 2 only checks it is still greater than the baseline), the notes are regenerated in Phase 3, and Phase 5 publishes by editing the draft instead of creating a new release. Only one draft can be resumed per run.
   - **Delete** → `gh release delete <tag> --yes --cleanup-tag` (a draft's tag usually does not exist yet; `--cleanup-tag` is a no-op then).
   - **Leave it** → keep going. The draft is ignored. If the version later collides with it, Phase 2 refuses.
     A draft is **never** a baseline.
2. **Baseline** = the published (non-draft) release with the latest `publishedAt`; prereleases count. Fallback when no published release exists: `git describe --tags --abbrev=0 --match "v[0-9]*" <sha>` (the nearest reachable semver tag). If a published release exists **and** `git describe` finds a different, newer reachable `v*` tag that has no release, show both and ask which one is the baseline.
3. **Ancestry:** `git merge-base --is-ancestor <baseline> <sha>`. If it fails, STOP: `Baseline <baseline> is not in main's history; resolve manually.`
4. **No baseline** → first release. The suggested version is `v0.1.0`, there is no `previous_tag_name`, and the range is all of `<sha>`.
5. `git rev-list --count <baseline>..<sha>` is `0` → STOP: `Nothing to release: main is at <baseline>.`

## Phase 2 — Suggest the version

1. `git log --format=%B%x00 <baseline>..<sha>` (first release: `git log --format=%B%x00 <sha>`). Each NUL-separated record is one full commit message. Main is rebase-only, so these are the individual commits as written with `/commit-message` (`type: subject`).
2. Classify each record:
   - **breaking**: the subject matches `^<type>(\([^)]*\))?!:`, or a line in the body starts with `BREAKING CHANGE:` or `BREAKING-CHANGE:`;
   - **feat**: the subject starts with `feat:` (or `feat(…):`);
   - **other**: everything else, including subjects with no conventional type.
3. Bump from the baseline (strip any `-pre` suffix first):
   - any breaking → major; while the major is `0`, minor instead;
   - else any feat → minor;
   - else → patch.
     Show the counts (`2 breaking, 5 feat, 11 other`) and list the breaking commits by short SHA + subject so the user can check the call.
4. **Version source:** a resumed draft's tag, else a `$ARGUMENTS` version, else the suggestion.
5. **Validate:**
   - matches `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$`, else STOP with the expected format;
   - is strictly greater than the baseline by semver precedence (`v1.2.0-rc.1` < `v1.2.0`), else STOP: `<version> is not greater than <baseline>`;
   - unless resuming that very draft: `git ls-remote --tags <https-url> refs/tags/<version>` prints nothing **and** `gh release view <version> --json tagName` fails with "release not found". Otherwise STOP: `Tag or release <version> already exists.`
6. `--prerelease` was passed, or the version has a `-pre` suffix → `<prerelease>` = true.

## Phase 3 — Draft the notes (GitHub-generated, then regrouped)

1. **Generate** (read-only; creates nothing):
   `gh api --method POST repos/<owner>/<repo>/releases/generate-notes -f tag_name=<version> -f target_commitish=<sha> -f previous_tag_name=<baseline> --jq .body`
   (drop `-f previous_tag_name=…` on a first release). GitHub computes the PR range itself, so there is no client-side pagination or range filtering. Keep the raw body as `<generated>`.
2. **Regroup.** Parse `<generated>`'s `* <title> by @<user> in <url>` lines and bucket them by the title's conventional prefix: `feat` → **Features**, `fix` → **Fixes**, everything else (including untyped titles) → **Other**. Breaking PRs (a `!` in the prefix) also get a **⚠ Breaking changes** section above the others, listed there only. Omit empty sections. Rules:
   - copy every PR line **verbatim**: regroup, never reword, never drop;
   - keep GitHub's `## New Contributors` section and the `**Full Changelog**: …` line unchanged, at the end;
   - add a 1–3 sentence plain summary at the top, derived from the PR titles only;
   - add `Closed epics: #<n> <title>, …` from `gh issue list --state closed --search "closed:>=<baseline-published-date>" --limit 200 --json number,title,labels`, filtered to issues that have sub-issues (`gh api repos/<owner>/<repo>/issues/<n>/sub_issues --jq length` > 0). Omit the line when there are none.
   - **Count check:** the number of `* … in https://github.com/…/pull/<n>` lines must equal the count in `<generated>`. If it doesn't, fix it before going on.
     Commits pushed to main without a PR do not appear in generated notes. That is accepted: `main` is protected and work lands through PRs.
3. **Write** the result with the Write tool to `.plans/release-<version>.md` (`mkdir -p .plans` first; it's gitignored scratch space, and the scratchpad is fine if `.plans` is not).
4. **Scan** (the release is world-readable once published):
   - gitleaks on the file: if `gitleaks dir --help` works, `gitleaks dir --redact --no-banner <file>`; else, if `docker info` works, `docker run --rm -v <dir>:<dir>:ro ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f dir --redact --no-banner <file>` (the same pinned image as `tooling/github/scripts/secrets-scan.sh`); if neither works, say so once. Exit 1 → **STOP** until the PR title or file is fixed.
   - Heuristic grep: `grep -nEi '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|/home/|C:\\Users|([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|passwd|password|secret|token|api[_-]?key|bearer|BEGIN .*PRIVATE KEY' <file>`. Drop hits whose only URL is `https://github.com/<owner>/<repo>/…` or `https://github.com/<user>`, and `127.0.0.1`. Every remaining hit is either edited out or explicitly accepted at the gate.

## Phase 4 — Gate

Show: version (and the bump reasoning from Phase 2), baseline, target `<short-sha>` + its subject, CI run URL, prerelease yes/no, whether a draft is being resumed, the notes in full, and the scan result (`Scan: clean` or the hit list). Then AskUserQuestion:

- **Publish** (recommended, unless `--draft` was passed)
- **Publish as draft**
- **Change version**: ask for it, re-run Phase 2 step 5 validation, regenerate Phase 3 (the tag name appears in the notes), and show the gate again
- **Abort**: stop. The notes file stays for reference; nothing was created on GitHub.

## Phase 5 — Publish

1. **Staleness recheck:** `git ls-remote <https-url> refs/heads/main`. If it no longer equals `<sha>`, say `main moved to <new-short-sha> since the gate` and go back to **Phase 0** (new CI check, version, notes, gate). Never publish the older SHA as "everything since the last release".
2. **Reconcile before creating** (and again after any error or timeout in step 3, before anything else): `gh release view <version> --json tagName,isDraft,isPrerelease,targetCommitish,url`.
   - **Not found** → step 3.
   - **Found, and it is the draft being resumed** → step 3 (edit path).
   - **Found otherwise** (a previous run's create succeeded server-side but the CLI timed out): if `targetCommitish` is `<sha>` (or `git ls-remote --tags <https-url> refs/tags/<version>` resolves to `<sha>`) and its draft/prerelease state matches what was approved, report `Release <version> already exists and matches: <url>` and finish. Otherwise, STOP and show the differences. Never create twice, and never edit a release this run didn't approve.
3. **Create or publish:**
   - New release: `gh release create <version> --target <sha> --title <version> --notes-file <file> [--draft] [--prerelease]`.
   - Resumed draft: `gh release edit <version> --target <sha> --title <version> --notes-file <file> [--prerelease] --draft=<true|false per the gate>`.
     If the command errors or times out, go to step 2. Never blindly retry.
4. Verify with `gh release view <version> --json url,isDraft,isPrerelease,tagName,targetCommitish` and print:
   ```
   Released <version> (<draft|prerelease|latest>) at <short-sha>: <url>
   Baseline: <baseline>  ·  PRs: <n>  ·  Notes: <file>
   ```
   For a draft, add: `Draft only: no tag exists until it is published. Run /release again and choose Resume to publish it.`
