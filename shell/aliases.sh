#!/usr/bin/env bash

# SSH login / logout aliases for WSL
# Manages SSH agent and keys for GitHub commit signing and pushing.

alias git-login='eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519'
alias git-logout='ssh-add -D'

# Commit helper — allows: commit fix: update something
commit() {
  git commit -m "$*"
}
