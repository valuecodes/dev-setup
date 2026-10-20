---
description: Commit staged changes with an auto-generated semantic commit message (does not push)
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git commit:*), AskUserQuestion
---

Commit the currently staged changes using an auto-generated semantic commit message. Show me the message, confirm, then commit. Do NOT push.

## Pre-flight

1. Run `git diff --cached --stat` to see what is staged.
2. If nothing is staged, tell me so and stop — suggest I run `git add <files>` first. Do NOT fall back to unstaged changes. Do NOT run `git add` on my behalf.

## Generate

Run `git diff --cached` and produce ONE commit message in the format:

`<type>: <subject>`

- `<type>` is one of: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- Do NOT include a scope — never `<type>(scope): ...`. Just `<type>: <subject>`.
- `<subject>`: present-tense imperative (e.g. "add hat wobble"), lowercase, no trailing period, ideally ≤ 72 chars.

Type guide: `feat` (new user-facing feature), `fix` (user-facing bug fix), `docs`, `style` (no behavior change), `refactor` (no behavior change), `test`, `chore` (build / tooling / deps).

## Confirm

Show the message in a fenced code block. Then call `AskUserQuestion` with the question `Commit with this message?` and these three options (in this exact order):

1. `Commit (Recommended)` — proceeds to commit.
2. `Edit message` — let the user supply a different message, then commit with that.
3. `Cancel` — stop without committing.

Do NOT commit without an affirmative answer from `AskUserQuestion`.

## Commit

On confirmation, run:

```
git commit -m "<message>"
```

Then print `git log -1 --oneline` so I can see the resulting commit.

Do NOT push. Do NOT amend. Do NOT use `--no-verify`. If the commit fails (e.g. pre-commit hook), tell me what failed — do not retry blindly.
