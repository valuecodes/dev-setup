---
description: Show CI checks (Actions) and comments for the current branch's PR (or a given PR number)
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh run list:*), Bash(gh run view:*), Bash(gh api:*), Bash(git rev-parse:*), Bash(git branch:*)
argument-hint: [PR-number]
---

Show CI status and comments for a PR. Read-only — never approves, merges, comments, or reruns anything.

Arguments: `$ARGUMENTS` — optional PR number. If omitted, use the PR for the current branch.

## Resolve PR

1. If `$ARGUMENTS` is a number, use that PR.
2. Otherwise, run `git rev-parse --abbrev-ref HEAD` and `gh pr view --json number,headRefName,state,isDraft,mergeable,title,url,updatedAt`. If no PR exists for the current branch, stop and say so.

## Checks (Actions)

Run `gh pr checks <PR>` (or `gh pr checks` if using current branch). Show each check on one line:

```
<icon> <name>  <conclusion>  <elapsed>  <url>
```

Use `✅` for success, `❌` for failure, `⏳` for in_progress/queued/pending, `⏭️` for skipped, `❔` for anything else. Sort failures first.

If any check failed, ALSO run `gh run view <runId> --log-failed | tail -60` for the most recent failed run and print that log block under the check list (fenced as `text`). Cap at 60 lines — if longer, say `(truncated, see <url> for full log)`.

## Comments

Fetch both kinds:

- General PR comments: `gh api repos/{owner}/{repo}/issues/<PR>/comments --jq '.[] | {user: .user.login, body: .body, at: .updated_at, url: .html_url}'`
- Review/line comments: `gh api repos/{owner}/{repo}/pulls/<PR>/comments --jq '.[] | {user: .user.login, body: .body, at: .updated_at, file: .path, line: (.line // .original_line), url: .html_url}'`
- Reviews (approvals/changes-requested): `gh api repos/{owner}/{repo}/pulls/<PR>/reviews --jq '.[] | {user: .user.login, state: .state, body: .body, at: .submitted_at}'`

Print them merged in chronological order. One block per comment:

```
@<user>  <state-or-tag>  <relative-time>
[<file>:<line>]                ← only if a line comment
<body — wrapped, max ~6 lines; truncate the rest with "…">
```

Tags: `[review:APPROVED]`, `[review:CHANGES_REQUESTED]`, `[review:COMMENTED]`, `[line]`, `[comment]`.

If there are zero comments, say `No comments.` and stop the section.

## Output structure

Print in this order, with one blank line between sections:

```
PR #<num>  <state>  <draft?>  <mergeable?>
<title>
<url>
updated <relative-time>

Checks:
<one line per check>

[failed-log block if applicable]

Comments (<count>):
<one block per comment>
```

Keep it skim-friendly. No prose preamble, no closing summary. Don't quote bodies in full if they're long.

Do NOT post comments, approve, request changes, merge, close, or rerun any workflow. This command is read-only.
