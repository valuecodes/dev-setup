---
description: Commit staged changes with an auto-generated semantic message, then push to the current branch
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git commit:*), Bash(git push:*), Bash(git fetch:*), Bash(git remote:*), Bash(git rev-parse:*), Bash(git branch:*), Bash(gh auth status:*), AskUserQuestion
---

Commit the currently staged changes on the branch I am already on, using an auto-generated semantic commit message, then push. Show me the message and the destination, confirm, then commit and push.

Commits are made **unsigned** (`--no-gpg-sign`) on purpose: signing here is SSH-format with a passphrase-protected key, and a non-interactive shell cannot answer the passphrase prompt.

The push goes over the repo's **HTTPS URL**, never over an SSH `origin` — same hard rule as `/ship-feature`, and for the same reason.

## Hard rules

- Never `git add`. Commit only what is already staged.
- Never switch, create, or rebase a branch. The branch is whatever `HEAD` is on when the command starts.
- Never `--no-verify`. Never `--amend`. Never force-push.
- Never push over the SSH `origin`, and never resolve the push URL through `gh repo view` — see Pre-flight step 4.
- Never use `$(…)` command substitution to inject the URL or the branch: resolve each in its own step, read the output, then write the next command with the value **inlined as a literal**. Do not hoist values into a leading `VAR=…;` statement or a `VAR=val git …` env prefix either — Claude Code does not strip those before matching `allowed-tools`, so any of these forces a needless permission prompt. Process wrappers (`timeout`, `time`, `nice`, `nohup`, `stdbuf`) *are* stripped, so `timeout 30 git push …` still matches `Bash(git push:*)`.
- Never retry a failed commit or push blindly — report exactly what failed.

## Pre-flight

1. `git rev-parse --abbrev-ref HEAD` → `<branch>`. **If it prints `HEAD`, the checkout is detached — stop.** There is no branch to push to. Tell me to check out a branch first.
2. `git status`. **Stop if a merge, rebase, cherry-pick, revert or bisect is in progress** — say which, and that this command is not for finishing one. Use the **long form**, not `--porcelain`: the porcelain formats emit only `branch.*` headers and file entries and never name an in-progress operation, while the long form states it in prose ("You are currently rebasing…", "All conflicts fixed but you are still merging"). For a machine-checkable confirmation, `git rev-parse --verify -q MERGE_HEAD` (likewise `CHERRY_PICK_HEAD`, `REVERT_HEAD`) exits 0 only when that operation is underway — but note it does **not** catch a rebase, which is why the long-form `git status` is the primary check.
3. `git diff --cached --stat`. If nothing is staged, tell me so and stop — suggest `git add <files>`. Do **not** fall back to unstaged changes and do **not** run `git add` on my behalf. Then `git diff --cached --name-only` and keep that list for the re-check at the end of Confirm.
4. `git remote get-url origin`, and rewrite it to HTTPS → `<https-url>`:
   - `git@github.com:OWNER/REPO.git` → `https://github.com/OWNER/REPO.git`
   - `ssh://git@github.com/OWNER/REPO` (with or without `.git`) → `https://github.com/OWNER/REPO.git`
   - already `https://…` → use it unchanged
   - no `origin`, or a host that is not `github.com` → stop and say why

   **Derive this from `origin`, never from `gh repo view`.** In a fork, gh's base-repo resolution can answer with the *parent* repository. This command pushes to `<https-url>` and then fetches from it back into `refs/remotes/origin/<branch>`, so a URL that disagrees with `origin` would push to the wrong repository and then overwrite the local `origin` ref with that repository's refs. Rewriting `origin`'s own URL cannot disagree with `origin` by construction.
5. Do **not** run `git ls-remote` as an auth check and do **not** gate on `gh auth status` here. On a public repo `ls-remote` succeeds anonymously and proves nothing, and the probe below subsumes it. A missing or unscoped token must fall back to commit-only, not refuse to commit.

Keep the branch name from step 1 and the staged file list from step 3 — both are re-checked at the end of Confirm.

## Probe the push

Run, with the URL and branch inlined as literals:

```
timeout 30 git push --dry-run <https-url> HEAD:refs/heads/<branch>
```

This does real auth, write-permission and fast-forward checks against the remote and writes nothing. Set `MODE` from the outcome:

- **Passed** → `MODE = commit+push`.
- **Auth or permission failure** — `403`, `Permission denied`, `Write access to repository not granted`, `could not read Username` → `MODE = commit-only`. Run `gh auth status` and fold the reason into the gate. The usual causes are a fine-grained PAT that does not cover this repo, or gh not being logged in (`gh auth login`).
- **Non-fast-forward** — the remote has moved → `MODE = commit-only`. Report it and suggest `git pull --rebase`. Never force-push.
- **Timeout, or anything else** → `MODE = commit-only`. Degrade, never hang.

**A passed probe is preflight, not a guarantee.** Report it as "preflight passed — the push may still be rejected", never as "the push will land". The dry run checks the *current* `HEAD`: the new commit does not exist yet, the remote can advance between the probe and the push, and server-side rules are only evaluated on the real push. The one that matters most here: **if the branch requires signed commits, the unsigned commit this command makes will be rejected at push time even though the probe passed.** If that happens, say so plainly — the commit is local and safe, and can be re-made signed once an agent is loaded (`eval "$(ssh-agent)" && ssh-add ~/.ssh/id_ed25519`).

## Generate

Run `git diff --cached` and produce ONE commit message in the format:

`<type>: <subject>`

- `<type>` is one of: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- Do NOT include a scope — never `<type>(scope): ...`. Just `<type>: <subject>`.
- `<subject>`: present-tense imperative (e.g. "add hat wobble"), lowercase, no trailing period, ideally ≤ 72 chars.

Type guide: `feat` (new user-facing feature), `fix` (user-facing bug fix), `docs`, `style` (no behavior change), `refactor` (no behavior change), `test`, `chore` (build / tooling / deps).

Subject line only — no body, and no trailers of any kind.

## Confirm

Show the message in a fenced code block, then one line naming the destination — the resolved `<https-url>` and `<branch>`, so the target repository is visible before anything is written — then the probe result.

`MODE` was fixed by the probe and **`Edit message` never changes it.** Editing the message re-enters this same gate under the same `MODE`. Track the two separately: an approved *message* is not an approved *operation*. Only `Commit + push` under a passed probe ever pushes.

When `MODE = commit+push`, call `AskUserQuestion` with the question `Commit and push to <branch>?` and these three options, in this exact order:

1. `Commit + push (Recommended)` — proceeds to Commit and push.
2. `Edit message` — take a replacement message from me, then re-show this gate.
3. `Cancel` — stop without committing.

When `MODE = commit-only`, call `AskUserQuestion` with the question `Push can't authenticate. Commit anyway?` — state the reason from the probe — and these three options, in this exact order:

1. `Commit only (Recommended)` — commit, skip the push, and print the exact push command to re-run later.
2. `Edit message` — take a replacement message from me, then re-show **this** gate, still under `commit-only`.
3. `Cancel` — stop without committing.

Do NOT commit or push without an affirmative answer from `AskUserQuestion`.

**After the affirmative answer and before committing**, re-run `git rev-parse --abbrev-ref HEAD` and `git diff --cached --name-only` and compare them against what Pre-flight recorded. If the branch or the staged set changed while the gate was open, abort and say what moved — never commit something other than what I approved.

## Commit and push

```
git commit --no-gpg-sign -m "<message>"
```

Then, only when `MODE = commit+push`, with the URL and branch inlined as literals:

```
timeout 60 git push <https-url> HEAD:refs/heads/<branch>
timeout 30 git fetch <https-url> refs/heads/<branch>:refs/remotes/origin/<branch>
```

`HEAD:refs/heads/<branch>` fully qualifies the destination so it cannot resolve to a tag or be created ambiguously. No `-u`: upstream tracking must keep pointing at the `origin` remote, never at a bare URL. The `fetch` line exists because pushing to a URL leaves `refs/remotes/origin/<branch>` stale, which would make `git status` keep reporting the branch as ahead — it is also why the URL must come from `origin`, since this line writes into `origin`'s ref namespace. If only the fetch fails, the push still succeeded: say so and move on.

Finally:

- Print `git log -1 --oneline`.
- Say once that the commit is **unsigned**.
- Name the branch that was pushed, or — if the push was skipped or failed — say the commit is local and safe, and print the exact command to retry:
  `git push <https-url> HEAD:refs/heads/<branch>`
