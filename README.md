# dev-setup

Personal development environment configuration and tooling.

## What's included

- **Shell aliases** — SSH login/logout plus a commit helper for Git workflows
- **VS Code workspace settings** — terminal profiles and Copilot configuration
- **Copilot instructions** — semantic commit message and PR description guidance
- **Extension recommendations** — suggested VS Code extensions for this setup
- **Prettier config** — shared formatting settings with a repo-level format script

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
