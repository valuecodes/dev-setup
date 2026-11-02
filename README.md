# dev-setup

Personal development environment configuration and tooling.

## What's included

- **Shell aliases** — SSH login/logout plus a commit helper for Git workflows
- **VS Code workspace settings** — terminal profiles and Copilot configuration
- **Copilot instructions** — semantic commit message and PR description guidance
- **Extension recommendations** — suggested VS Code extensions for this setup
- **oxfmt config** — formatting settings with repo-level format scripts
- **Secrets scan** — a gitleaks scan of the repo's git history
- **Claude Code config** — global slash commands, settings and hooks in `claude/`

## Setup

```bash
pnpm install
```

### Shell aliases

Add the aliases file from your clone path to `~/.bashrc`:

```bash
source /absolute/path/to/dev-setup/shell/aliases.sh
```

Reload the shell:

```bash
source ~/.bashrc
```

`git-login` expects your SSH key at `~/.ssh/id_ed25519`.

### VS Code

Open this repository in VS Code to use the workspace settings in `.vscode/`.

- `settings.json` adds terminal profiles and Copilot commit/PR instructions
- `extensions.json` recommends the related editor extensions

### Claude Code

`claude/` holds the global Claude Code config that normally lives in `~/.claude`:

- `commands/` — slash commands (`/ship-feature`, `/ship-plan`, `/ship-issue`, `/ship-deps`, `/vet-deps`, `/vet-all-deps`, `/pull-main`, `/release`, `/retro`, `/permission-review`, …)
- `settings.json` — model, permission allowlist, hooks and plugins
- `hooks/allow-worktree-commands.ts` — PreToolUse hook used by `settings.json`; Node runs it directly by stripping the types. `allow-worktree-commands.test.ts` next to it holds its offline tests
- `scripts/prompted-commands.ts` — read-only report of permission prompts from the local transcripts, used by `/permission-review`
- `scripts/vet-scan.ts` and `vet-scan/` — supply-chain diff scanner used by `/vet-deps`, `/vet-all-deps` and `/ship-deps`. It downloads the old and new version of an npm package or GitHub Action (or takes two archives or directories), runs the ast-grep rules in `vet-scan/rules/` on both, and reports only what the new version adds: process spawning, `eval`, network calls, credential and env reads, decode-then-run, long blobs and obfuscation in JS/TS, Python and shell. It reads the rules from `~/.claude/vet-scan`, so that folder needs its symlink too

Link them into `~/.claude` from your clone path (back up existing files first):

```bash
mv ~/.claude/commands ~/.claude/commands.bak
mv ~/.claude/hooks ~/.claude/hooks.bak
mv ~/.claude/scripts ~/.claude/scripts.bak
mv ~/.claude/vet-scan ~/.claude/vet-scan.bak
mv ~/.claude/settings.json ~/.claude/settings.json.bak
ln -s /absolute/path/to/dev-setup/claude/commands ~/.claude/commands
ln -s /absolute/path/to/dev-setup/claude/hooks ~/.claude/hooks
ln -s /absolute/path/to/dev-setup/claude/scripts ~/.claude/scripts
ln -s /absolute/path/to/dev-setup/claude/vet-scan ~/.claude/vet-scan
ln -s /absolute/path/to/dev-setup/claude/settings.json ~/.claude/settings.json
```

Notes:

- The allowlist auto-approves project scripts like `pnpm lint` and `pnpm test`. A repo controls what those run, so this assumes you only open trusted repos.
- The Codex `node … codex-companion.mjs` allow rule pins a home path and plugin version. Update it on another machine or after a plugin upgrade.
- With the symlinks in place, any settings change made from Claude Code shows up here. Review `git diff claude/` before committing, because this repo is public.
- Never add other `~/.claude` files: `.credentials.json`, `settings.local.json`, `history.jsonl`, `projects/`, `plans/`, `file-history/`, `paste-cache/`, `shell-snapshots/`, `sessions/`, `vet-all-deps/` (scan reports) and similar hold tokens, transcripts and work data.

#### vet-scan prerequisite

`vet-scan.ts` needs ast-grep 0.51.0 on `PATH`:

```bash
cargo install ast-grep --locked --version =0.51.0
```

The script calls it as `ast-grep`, never `sg`: on many Linux systems `sg` is the shadow-utils group command.

Run the rule tests after changing a rule:

```bash
ast-grep test --config claude/vet-scan/sgconfig.yml
```

### Usage

Start the SSH agent and add your key:

```bash
git-login
```

Remove loaded keys from the agent:

```bash
git-logout
```

Commit with an inline message (no quotes needed):

```bash
commit fix: update Content-Security-Policy to remove script hash
```

Format the repo files, or only check them:

```bash
pnpm format
pnpm format:check
```

`claude/` is formatted too. Claude Code rewrites `settings.json` in its own layout when you add a permission, so run `pnpm format` again before committing a settings change.

Type-check the hooks and scripts, and run the hook tests:

```bash
pnpm typecheck
node claude/hooks/allow-worktree-commands.test.ts
```

Scan the git history for committed secrets (needs gitleaks v8.19+ or Docker):

```bash
pnpm secrets:scan
```

This is a manual check. It only sees committed history, not uncommitted files, and nothing runs it automatically.
