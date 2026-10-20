---
description: Triage outdated pnpm packages, research what each upgrade entails, then update the approved set
allowed-tools: Bash(pnpm outdated:*), Bash(pnpm up:*), Bash(pnpm typecheck:*), Bash(pnpm lint:*), Bash(pnpm test:*), Bash(pnpm build:*), Bash(git status:*), Bash(git diff:*), Bash(cat:*), Bash(jq:*), Read, WebSearch, WebFetch, AskUserQuestion
argument-hint: [--dev | --prod]
---

Survey outdated packages in this pnpm workspace, research what each update is, propose a targeted upgrade plan, get my confirmation, then run the update. Do NOT commit.

Arguments: `$ARGUMENTS` — optional. Pass `--dev` or `--prod` through to `pnpm outdated` to scope the check.

## 1. Pre-flight

1. `git status --porcelain` — if there are uncommitted changes touching `package.json` or `pnpm-lock.yaml`, STOP and tell me to commit or stash first. Other unrelated WIP is fine but warn me.
2. Confirm this is a pnpm workspace by reading `pnpm-workspace.yaml` (or at least `package.json` with `packageManager: pnpm@*`). If not, stop.

## 2. Survey

Run:

```
pnpm outdated -r --format json $ARGUMENTS
```

If the output is empty / `{}`, say "Everything is up to date." and stop.

Parse the JSON. For each entry capture: package name, current version, latest version, type (`dependencies` / `devDependencies`), and which workspace(s) it appears in.

Classify the bump for each package:
- **patch** — `x.y.Z` only changed
- **minor** — `x.Y.z` changed (and major matches)
- **major** — `X.y.z` changed
- **prerelease / weird** — anything else (e.g. `0.x` minor bumps, which are effectively major in semver)

Treat `0.x` minor bumps as major-equivalent (breaking by convention).

## 3. Research

For each **major** and **prerelease/weird** entry, look up release notes before classifying:

- Try `WebSearch` for `<package> <new-version> release notes` or `<package> changelog <new-version>`.
- If the package has a known repo, prefer `WebFetch` on `https://github.com/<owner>/<repo>/releases/tag/v<new-version>` or the repo's `CHANGELOG.md`.
- Cap research at ~3 lookups per package; summarize in one line per package.

For **patch** and **minor** entries, do not research — assume safe unless the name is a well-known framework where minor bumps are routinely breaking (e.g. eslint configs, type-only packages tied to a runtime). Use judgment, note exceptions explicitly.

## 4. Triage table

Print one table, grouped by bump class (patch first, then minor, then major):

```
PACKAGE                 CURRENT → LATEST    CLASS   RECOMMEND   NOTES
<name>                  1.2.3 → 1.2.7       patch   update      —
<name>                  4.5.0 → 5.0.0       major   review      drops Node 18; new ESM-only export
<name>                  0.3.1 → 0.4.0       major   hold        breaking type changes, see CHANGELOG
```

Recommendation rules:
- `update` — safe to bump now (patch / minor with no known issues).
- `review` — major bump, but release notes look manageable. Worth doing in this pass with awareness.
- `hold` — major bump with breaking changes that need code edits before updating. Do NOT include in the upgrade command this round.

If you researched a package, the `NOTES` cell must reflect what you actually found. Don't say "see changelog" — summarize the breaking change in ≤ 80 chars.

## 5. Plan

Below the table, print the exact command that would run, with packages from rows recommended `update` or `review`:

```
pnpm up --latest -r <pkg1> <pkg2> ...
```

If the list is empty (only `hold` rows), say so and stop — nothing to upgrade automatically.

**Gate.** Call the `AskUserQuestion` tool with the question `Run this update?` and these three options (in this exact order):

1. `Run update (Recommended)` — proceeds to section 6.
2. `Edit list` — let the user reclassify rows (e.g. "move <pkg> to hold", "add <pkg> back in"), then re-show the command and re-ask.
3. `Cancel` — stop without running anything.

Do not run `pnpm up` without an affirmative answer from `AskUserQuestion`.

## 6. Apply (only after gate = yes)

1. Run the confirmed `pnpm up --latest -r <pkgs...>` command.
2. If pnpm errors out, STOP and show the error — do not retry blindly.
3. Run validation, but only scripts that exist in the root `package.json`:
   ```
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```
   Skip any script that isn't defined. Show pass/fail for each.
4. Show `git diff --stat package.json '**/package.json' pnpm-lock.yaml` so I can see what moved.

## 7. Summary

Print:

- `Updated: <N>   Held: <N>   Validation: <ok|failed>`
- The exact list of packages that were upgraded, with `old → new` versions.
- If validation failed, the failing script name. Do NOT try to "fix" the failure in this command — that's a separate task.

Do NOT commit. Do NOT push. Leave the working tree dirty for me to review and commit manually.

## Hard rules

- Never run `pnpm up` before the gate is confirmed.
- Never include `hold` packages in the upgrade command, even if they're in the same workspace.
- Never edit source code to "fix" a breaking change in this command — flag it and stop.
- Never commit or push.
- Never use `--no-verify` or skip validation. If validation fails, surface it.
