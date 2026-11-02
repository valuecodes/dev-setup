---
description: Fast-forward the local base branch (main, else master) from GitHub over HTTPS with the gh token, the same way /ship-feature Phase 0 does
disable-model-invocation: true
allowed-tools: Bash(gh:*), Bash(git:*)
---

Bring the local base branch of the current repo up to date with GitHub. Fast-forward only: never merge, rebase, stash, reset or force anything.

**Git over HTTPS only.** Use the repo's HTTPS URL via the `gh` token. Never use the SSH `origin`: it blocks on the key passphrase, which the non-interactive shell can't answer. Run each command as its own call, with `git -C <path>` rather than `cd`, and no `$(…)`.

## 1. Pre-flight

1. `git rev-parse --show-toplevel` → `<repo-root>`. If it fails, STOP: not a git repo.
2. `gh auth status` must succeed. If it fails, STOP and tell the user to run `gh auth login`.
3. `gh repo view --json url,nameWithOwner` → `<https-url>` (url + `.git`) and `<owner>/<repo>`. This is gh's default repo, which in a fork can be the upstream: name it in the report.
4. Confirm git itself authenticates non-interactively: `git -C <repo-root> ls-remote <https-url> HEAD` with the Bash tool `timeout` at 60000. `gh auth status` alone does not prove git's credential helper works. A username/password prompt, a timeout or an auth error → STOP and tell the user to run `gh auth setup-git`.
5. Base branch = `main` if `git -C <repo-root> rev-parse --verify --quiet refs/heads/main` succeeds, else `master`. If neither, STOP.
6. `git -C <repo-root> rev-parse <base>` → `<old>` (full sha). `git -C <repo-root> worktree list --porcelain` → `<base-wt>`: the path of the worktree whose `branch refs/heads/<base>` line matches, or none.

## 2. Fetch and classify

1. `git -C <repo-root> fetch <https-url> <base>`, Bash `timeout` 120000. If it fails, STOP with git's message.
2. `git -C <repo-root> rev-parse FETCH_HEAD` → `<remote>`. Use this sha from here on, not `FETCH_HEAD`, which another fetch can overwrite.
3. Classify (each `merge-base` as its own call, exit 0 = true):
   - `<old>` equals `<remote>` → **up to date**.
   - `git -C <repo-root> merge-base --is-ancestor <old> <remote>` → **behind**: fast-forward (section 3).
   - `git -C <repo-root> merge-base --is-ancestor <remote> <old>` → **ahead**: local has unpushed commits. Move nothing; report how many (`git -C <repo-root> rev-list --count <remote>..<old>`).
   - otherwise → **diverged**: STOP. Report both shas and `git -C <repo-root> log --oneline <remote>..<old>` (the local-only commits). The user reconciles it; never rebase or reset.

## 3. Fast-forward (behind only)

- `<base>` is checked out in a worktree (`<base-wt>`, which may be `<repo-root>` itself) → `git -C <base-wt> merge --ff-only <remote>`. Uncommitted work is fine: git refuses only if the update would overwrite it.
- `<base>` is not checked out anywhere → `git -C <repo-root> fetch <https-url> <base>:refs/heads/<base>`. Git only accepts this as a fast-forward and refuses a branch checked out in a worktree, so it can't strand anyone's files. If it moved the ref somewhere other than `<remote>` (the remote advanced between fetches), use the new sha as `<remote>` in the report.

If git refuses (uncommitted work would be overwritten, or anything else), STOP with git's reason and the fix for the user (commit, stash or move that work). Never resolve it yourself.

## 4. Sync `origin/<base>` (only to the fetched remote sha)

Only if `origin` is the same repo: `git -C <repo-root> remote get-url origin` must name `<owner>/<repo>` (`git@github.com:<owner>/<repo>.git`, `https://github.com/<owner>/<repo>(.git)` or `ssh://git@github.com/<owner>/<repo>(.git)`, case-insensitive). Then `git -C <repo-root> update-ref refs/remotes/origin/<base> <remote>`. Always the fetched `<remote>`, never the local branch: that would hide unpushed commits from `git status`. Otherwise skip it and say why (fork, other remote, no `origin`).

Do this in every non-diverged case, including up to date and ahead, so a stale tracking ref left by an earlier HTTPS pull gets fixed.

## 5. Report

- Header: `<owner>/<repo> <base>`, plus which worktree holds it (or "not checked out").
- **up to date** → `already up to date at <short sha>`.
- **ahead** → `local <base> is N commits ahead of GitHub; nothing pulled`, and list them with `git -C <repo-root> log --oneline <remote>..<old>`.
- **behind** → `<short old> → <short remote>`, then `git -C <repo-root> log --oneline <old>..<remote>` and `git -C <repo-root> diff --stat <old> <remote>`. If the current checkout (`git -C <repo-root> rev-parse --abbrev-ref HEAD`) is not `<base>`, say that it stayed on that branch (or detached HEAD) and only `<base>` moved.
- Whether `origin/<base>` was synced or skipped.
- If `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml` is in the diff, suggest `pnpm install`. Don't run it.
