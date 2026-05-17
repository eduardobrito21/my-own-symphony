#!/usr/bin/env bash
# clone-and-checkout.sh — clone the target repo into /workspace
# inside the agent container, then check out the work branch.
#
# Uploaded by namespace-create.sh at @sandbox provision time and
# executed via:
#
#   nsc ssh <id> --container_name agent -T -- \
#     /opt/symphony/clone-and-checkout.sh <REPO_URL> <DEFAULT_BRANCH> <BRANCH>
#
# Why an uploaded script instead of inline `bash -c '<commands>'`:
# `nsc ssh --container_name` invokes the command via the container
# runtime's exec primitive (not a shell), and splits the command
# string on whitespace before forming argv. A multi-line script as a
# single argv item gets parsed as ["set", "-euo", "pipefail", ...]
# and exec fails with `exec: "set": executable file not found`.
# Uploading the script and invoking it by absolute path sidesteps
# the issue: argv becomes [script-path, arg1, arg2, arg3] — four
# clean strings. The kernel exec's the script which then interprets
# its own body via the shebang's `bash`.
#
# Discovered during the EDU-22 smoke (2026-05-17 — Plan 18b).
#
# Args:
#   $1 - repo URL (e.g. https://github.com/foo/bar.git)
#   $2 - default branch (e.g. main)
#   $3 - work branch (e.g. symphony/EDU-22)
#
# Env (vault-injected into the agent container):
#   GITHUB_TOKEN - optional; embedded inline in the clone URL so
#                  HTTPS auth works for private repos without ever
#                  landing on argv or in .git/config.

set -euo pipefail

REPO_URL="${1:?REPO_URL is required (positional arg 1)}"
DEFAULT_BRANCH="${2:?DEFAULT_BRANCH is required (positional arg 2)}"
BRANCH="${3:?BRANCH is required (positional arg 3)}"

# /workspace is the container's WORKDIR (per the Dockerfile) and the
# standard mount point Symphony's downstream sub-agents expect.
WORKTREE="/workspace"
git config --global --add safe.directory "$WORKTREE"

# Build the clone URL. With GITHUB_TOKEN, embed it inline so the
# fetch authenticates without us threading it through argv or
# .git/config. We strip it back out via `git remote set-url` once
# the working copy exists; future fetches/pushes use the credential
# from the container's env (Plan 18b vault injection).
if [ -z "${GITHUB_TOKEN:-}" ]; then
  CLONE_URL="$REPO_URL"
else
  CLONE_URL="$(printf '%s' "$REPO_URL" | sed "s|https://|https://x-access-token:${GITHUB_TOKEN}@|")"
fi

# The container's WORKDIR is /workspace and the Dockerfile creates
# it empty. Two cases:
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
