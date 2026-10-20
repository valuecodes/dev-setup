# dev-setup

Personal development environment configuration and tooling.

## What's included

- **Shell aliases** — SSH login/logout plus a commit helper for Git workflows
- **VS Code workspace settings** — terminal profiles and Copilot configuration
- **Copilot instructions** — semantic commit message and PR description guidance
- **Extension recommendations** — suggested VS Code extensions for this setup
- **Prettier config** — shared formatting settings with a repo-level format script
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

- `commands/` — slash commands (`/commit`, `/pr-open`, `/ship-feature`, …)
- `settings.json` — model, permission allowlist, hooks and plugins
- `hooks/allow-worktree-commands.mjs` — PreToolUse hook used by `settings.json`

Link them into `~/.claude` from your clone path (back up existing files first):

```bash
mv ~/.claude/commands ~/.claude/commands.bak
mv ~/.claude/hooks ~/.claude/hooks.bak
mv ~/.claude/settings.json ~/.claude/settings.json.bak
ln -s /absolute/path/to/dev-setup/claude/commands ~/.claude/commands
ln -s /absolute/path/to/dev-setup/claude/hooks ~/.claude/hooks
ln -s /absolute/path/to/dev-setup/claude/settings.json ~/.claude/settings.json
```

Notes:

- The allowlist auto-approves project scripts like `pnpm lint` and `pnpm test`. A repo controls what those run, so this assumes you only open trusted repos.
- The Codex `node … codex-companion.mjs` allow rule pins a home path and plugin version. Update it on another machine or after a plugin upgrade.
- With the symlinks in place, any settings change made from Claude Code shows up here. Review `git diff claude/` before committing, because this repo is public.
- Never add other `~/.claude` files: `.credentials.json`, `settings.local.json`, `history.jsonl`, `projects/`, `plans/`, `file-history/`, `paste-cache/`, `shell-snapshots/`, `sessions/` and similar hold tokens, transcripts and work data.

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

Format the repo files:

```bash
pnpm format
```
