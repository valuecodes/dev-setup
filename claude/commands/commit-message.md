---
description: Generate a semantic commit message from staged changes (does not commit)
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git diff --cached:*)
---

Generate a semantic commit message for the currently staged changes. Do NOT run `git commit` — only produce the message text for me to copy-paste.

Steps:

1. Run `git diff --cached` to see what is staged.
2. If nothing is staged, tell me so and stop — do not fall back to unstaged changes.
3. Otherwise, analyze the diff and produce ONE commit message in the format:

   `<type>: <subject>`

   - `<type>` is one of: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
   - Do NOT include a scope — never emit `<type>(scope): ...`. Just `<type>: <subject>`.
   - `<subject>` is a present-tense, imperative summary (e.g. "add hat wobble", not "added" or "adds"). Lowercase, no trailing period, ideally under 72 chars.

Type guide:
- `feat`: new user-facing feature
- `fix`: user-facing bug fix
- `docs`: documentation only
- `style`: formatting / whitespace / semicolons; no code behavior change
- `refactor`: code restructuring with no behavior change
- `test`: adding or refactoring tests
- `chore`: build, tooling, deps; no production code change

Output exactly ONE line — just the commit message itself, in a fenced code block so I can copy it cleanly. No preamble, no explanation, no alternatives.
