---
description: Triage PR review comments, fix the valid ones, then reply to each comment (manual commit + push)
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr comment:*), Bash(gh api:*), Bash(gh repo view:*), Bash(gh run view:*), Bash(gh run list:*), Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git rev-parse:*), Bash(git branch:*), Bash(pnpm:*), AskUserQuestion
argument-hint: [PR-number]
---

Triage PR review comments, fix the valid ones, then reply to each comment. The command will NOT commit or push — that's a manual step. Three confirmation gates: never proceed past one without my explicit "yes".

Arguments: `$ARGUMENTS` — optional PR number. If omitted, use the PR for the current branch.

## 1. Resolve PR (read-only)

If `$ARGUMENTS` is a number, use that PR. Otherwise `gh pr view --json number,headRefName,state,title,url,baseRefName`. Stop if no PR exists for the current branch.

Capture `<owner>` and `<repo>` from `gh repo view --json owner,name`.

## 2. Fetch comments + checks (read-only)

Comments — pull all three sources, retaining each comment's `id` (needed to reply):

- General PR comments: `gh api repos/<owner>/<repo>/issues/<PR>/comments`
- Review / line comments: `gh api repos/<owner>/<repo>/pulls/<PR>/comments`
- Review summaries / approvals: `gh api repos/<owner>/<repo>/pulls/<PR>/reviews`

Skip any comment authored by the current `gh api user --jq .login` (don't re-engage your own past replies).

Checks — run `gh pr checks` (exit code 8 means "not all complete", that's fine, parse the output anyway). For each check that finished with `failure`, fetch the tail of the failed job log:

```
gh run view <runId> --log-failed | tail -60
```

Cap at 60 lines per failure; truncate longer with a note pointing at the check URL.

## 3. Triage

First, print a one-line check summary: `Checks: <N> ✓ · <N> ✗ · <N> ⏳`. If everything is passing or pending, say so.

Then classify each comment AND each failed check:

- **valid** — concrete claim or actionable suggestion grounded in the diff. Will be fixed. Replies posted.
- **question** — clarifying question; no code change, but reply needed.
- **noise** — bot welcome / "review enabled" / auto-generated PR overview / "show summary per file" / known-flaky CI failure. No fix, no reply by default.
- **approved** — APPROVED review with no concrete request. Acknowledge with `👍 thanks`, no fix.
- **ci-failure** — a failed Action / check that points at a real problem in the diff (test/typecheck/lint/format). Will be fixed. NO reply (CI re-runs after push).

For ci-failure rows use the check name as `AUTHOR` and the failed-job URL as the `id`. Put a one-line root cause (parsed from the failed log tail) in the summary.

Show one table:

```
ID           AUTHOR                FILE:LINE                  CLASS         ONE-LINE SUMMARY
<id>         <user | check-name>   <path:line | -->           <class>       <≤ 90 chars>
```

Then propose a fix plan for everything classified `valid` or `ci-failure`:

```
[id <id>]  <file>(:line)
  → <one-line description of the change>
```

Group related fixes (same file or shared root cause) into a single edit when natural.

**GATE 1.** Call `AskUserQuestion` with the question `Triage + fix plan look right?` and these three options (in this exact order):

1. `Apply fixes (Recommended)` — proceeds to section 4.
2. `Edit triage` — let the user reclassify (e.g. "id 1234 is noise") or adjust the plan, then re-ask.
3. `Cancel` — stop without applying anything.

## 4. Apply fixes (only after Gate 1 = yes)

1. If `git status --porcelain` is non-empty, STOP — don't mix the user's WIP into the fix commit. Tell me to stash/commit first.
2. Make minimal edits per the confirmed plan. Don't fix things that weren't reported.
3. Run validation, only scripts that exist in `package.json`:
   ```
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm format
   ```
   If any fail, STOP and show the failure. Do not commit broken code, do not post replies promising a non-existent fix.
4. Show me the diff (`git diff`) for review.

**GATE 2.** Call `AskUserQuestion` with the question `Fixes look right?` and these three options (in this exact order):

1. `Looks good (Recommended)` — proceeds to draft commit message.
2. `Edit fixes` — let the user request adjustments, then re-validate and re-ask.
3. `Cancel` — stop; leave the working tree dirty for the user.

On the affirmative answer, do NOT commit and do NOT push. Instead:

5. Print a suggested commit message I can copy-paste:

   ```
   fix: address PR review feedback

   addresses: <comment-id>, <comment-id>
   ```

6. STOP. Wait for me to commit + push manually. When I reply with `pushed` (or equivalent), continue to section 5 below — not before.
7. Once I confirm, run `git rev-parse HEAD` to capture the new commit SHA. It goes in the reply text.

## 5. Draft replies (only after Gate 2 = yes)

For each row classified `valid`, `question`, or `approved`, write a reply. Skip `ci-failure` (CI re-runs after push) and `noise` (silence).

Style: terse, one or two sentences max. Per-class template:

- `valid` → `Fixed in <sha>: <one-line of what changed>.` Optionally a brief follow-up if the fix isn't 1:1 to the suggestion.
- `question` → answer directly. Don't speculate. If the answer is "this is intentional because X", say that.
- `approved` → `👍 thanks`.
- `ci-failure` → no reply.
- `noise` → no reply.

Show all drafts in one block, grouped by comment id.

**GATE 3.** Call `AskUserQuestion` with the question `Post these replies (and resolve threads for fix-landed rows)?` and these three options (in this exact order):

1. `Post replies (Recommended)` — proceeds to section 6.
2. `Edit drafts` — let the user revise specific replies, then re-ask.
3. `Cancel` — stop without posting anything.

## 6. Post replies + resolve threads (only after Gate 3 = yes)

### 6.1 Post replies

- **Review / line comment** (came from `pulls/<PR>/comments`): reply in-thread:
  `gh api --method POST repos/<owner>/<repo>/pulls/<PR>/comments/<id>/replies -f body="<reply>"`
- **General PR comment** (came from `issues/<PR>/comments`): `gh pr comment <PR> --body "<reply>"`, quoting the original with `> @<user>` for context.
- **Review summary** (came from `pulls/<PR>/reviews`): no per-thread reply API. If a reply is genuinely warranted (rare), post a general comment @-mentioning the reviewer; otherwise skip.

After each post, confirm it returned a 200/201. If any fail, list exactly which — don't claim success for a failed post.

### 6.2 Resolve threads for fix-landed rows

A row is "fix-landed" iff its reply starts with `Fixed in <sha>:` — i.e. the fix actually shipped in the commit. Mark each such review thread resolved. Do NOT resolve `noise`, `question`, `approved`, `ci-failure`, or deferred-fix `valid` threads.

1. List the PR's review threads with their constituent comment ids:
   ```
   gh api graphql -F owner=<owner> -F name=<repo> -F num=<PR> -f query='query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){reviewThreads(first:100){nodes{id isResolved comments(first:10){nodes{databaseId}}}}}}}'
   ```
2. For each fix-landed reply, find the thread whose `comments.databaseId` list includes the original comment id. If `isResolved` is already `true`, skip. Otherwise resolve:
   ```
   gh api graphql -F threadId=<thread-node-id> -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}'
   ```
3. Confirm each response shows `thread.isResolved == true`. List any failures by original comment id.

General PR comments (issues/comments) and review summaries don't have line-thread structure — nothing to resolve there.

## 7. Final summary

Print:

- `Triaged: <N>  Fixed: <N> (review + <N> ci)  Replied: <N>  Resolved: <N>  Skipped (noise): <N>`
- Commit SHA(s)
- PR URL

Stop.

## Hard rules

- Never edit code before Gate 1 confirms.
- Never run `git commit` or `git push`. Those are manual — print the suggested commit message, then wait for me to confirm `pushed`.
- Never post replies before Gate 3 confirms.
- Never promise a fix that didn't actually land. Validation must pass AND I must confirm `pushed` before drafting replies.
- Never address a comment that wasn't in the confirmed set (no scope creep).
- Never reply to your own past comments.
- **Emit `gh` commands so the allowlist matches.** Write each as a single command that *starts with `gh`* with literal values inlined (`gh api --method POST repos/owner/repo/pulls/1/comments/<id>/replies …`). Do NOT hoist values into leading `VAR=…;` assignments or a `VAR=val gh …` env prefix — Claude Code splits on `;`/newlines and matches each sub-command independently and does not strip env-var prefixes, so either form defeats `Bash(gh api:*)` and forces a needless prompt. Any piped helper (`| head`, `| tail`) needs its own allow rule too.
- Never resolve a thread for a deferred-fix `valid` row (reply was "Agreed, tracking" rather than "Fixed in <sha>"). Only resolve threads where the fix actually shipped in the commit.
