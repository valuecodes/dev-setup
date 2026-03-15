# dev-setup

Personal development environment configuration and tooling.

## What's included

- **Shell aliases** — SSH login/logout, commit helper for WSL git workflows
- **VSCode settings** — terminal profiles, Copilot config
- **Commit message instructions** — semantic commit format for Copilot generation
- **PR description template** — standardized pull request format with security review

## Setup

```bash
pnpm install
```

### Shell aliases

Add this line to `~/.bashrc`:

```bash
source ~/code/dev-setup/shell/aliases.sh
```

Reload the shell:

```bash
source ~/.bashrc
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
