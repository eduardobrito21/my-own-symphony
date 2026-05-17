#!/usr/bin/env bash
# clone-and-checkout.sh — clone the target repo into /workspace
# inside the bare Namespace microVM, then check out the work branch.
#
# Uploaded by namespace-create.sh at @sandbox provision time and
# executed via:
#
#   nsc ssh <id> -T -- \
#     bash /opt/symphony/clone-and-checkout.sh <REPO_URL> <DEFAULT_BRANCH> <BRANCH>
#   <<<EOF
#   GITHUB_TOKEN=<value>
#   EOF
#
# Why an uploaded script instead of inline `bash -c '<commands>'`:
# `nsc ssh` invokes the command via Namespace's command-service
# (not a shell) and splits the command string on whitespace to form
# argv. Inlining a multi-statement script as one argv item doesn't
# work — the first whitespace-bounded token (e.g. `set`) is taken
# as the executable. An uploaded script invoked by absolute path
# gives a clean four-element argv: [script-path, repo,
# default-branch, branch].
#
# Args:
#   $1 - repo URL (e.g. https://github.com/foo/bar.git)
#   $2 - default branch (e.g. main)
#   $3 - work branch
#
# Env / stdin (Plan 18c):
#   GITHUB_TOKEN can come from either:
#     - the current shell's env (if a caller pre-exported it), OR
#     - the first stdin line in the form `GITHUB_TOKEN=<value>`.
#   The script reads stdin only if env is empty; either way the
#   token never lands on argv or in .git/config.

set -euo pipefail

REPO_URL="${1:?REPO_URL is required (positional arg 1)}"
DEFAULT_BRANCH="${2:?DEFAULT_BRANCH is required (positional arg 2)}"
BRANCH="${3:?BRANCH is required (positional arg 3)}"

# If GITHUB_TOKEN isn't already in env, drain stdin looking for it.
# Other KEY=value lines (forward-compat) are exported too. EOF or an
# empty stdin both result in GITHUB_TOKEN staying unset, which is the
# correct behavior for a public repo.
if [ -z "${GITHUB_TOKEN:-}" ] && [ ! -t 0 ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *=*) export "$line" ;;
    esac
  done
fi

# /workspace is the well-known root namespace-create.sh creates and
# chowns to the symphony user; this script runs from there.
WORKTREE="/workspace"
git config --global --add safe.directory "$WORKTREE"

# Build the clone URL. With GITHUB_TOKEN, embed it inline so the
# fetch authenticates without us threading it through argv or
# .git/config. We strip it back out via `git remote set-url` once
# the working copy exists; future fetches/pushes use the credential
# from the agent's env (delivered per-stage by dispatch.sh's stdin
# in Plan 18c).
if [ -z "${GITHUB_TOKEN:-}" ]; then
  CLONE_URL="$REPO_URL"
else
  CLONE_URL="$(printf '%s' "$REPO_URL" | sed "s|https://|https://x-access-token:${GITHUB_TOKEN}@|")"
fi

# Two cases:
#
#   - First dispatch: /workspace is empty → `git clone` clones into
#     it (git accepts an existing empty target dir).
#   - Re-dispatch on the same instance (same `uniqueTag`):
#     /workspace already has .git → we skip the clone and let the
#     `git fetch + checkout` block below pick up where we left off.
#
# No cleanup branch: nothing should leave stuff in /workspace
# without a .git (we control the only producer, which is git itself).
# If somehow it does, the clone below errors loudly — operator's
# concern, not the dispatch script's.
if [ ! -d "$WORKTREE/.git" ]; then
  git clone "$CLONE_URL" "$WORKTREE"
fi

cd "$WORKTREE"

# Replace the remote URL with the clean form (no token) so any
# subsequent operation that reads .git/config doesn't see the
# credential. Git's credential helpers / env fall back to
# GITHUB_TOKEN when needed.
git remote set-url origin "$REPO_URL"

git fetch origin
git checkout "$DEFAULT_BRANCH"
git pull --ff-only origin "$DEFAULT_BRANCH"

# Create the work branch from default branch if it doesn't exist;
# otherwise just check it out (re-dispatch case).
git checkout "$BRANCH" 2>/dev/null \
  || git checkout -b "$BRANCH" "$DEFAULT_BRANCH"
