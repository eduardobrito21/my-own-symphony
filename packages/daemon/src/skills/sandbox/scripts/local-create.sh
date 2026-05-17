#!/usr/bin/env bash
# local-create.sh — provision a local-docker (or local-shell) sandbox.
#
# Inputs (env vars set by the parent agent):
#   SYMPHONY_REPO_URL        — Git repo URL to clone.
#   SYMPHONY_DEFAULT_BRANCH  — Default branch (e.g. main) to base work on.
#   SYMPHONY_BRANCH          — Work branch to checkout/create.
#   SYMPHONY_IDENTIFIER      — Issue identifier (e.g. EDU-13) for naming.
#
# Cwd: the daemon's per-issue workspace. Becomes the worktree directory.
#
# Output: a SandboxHandle JSON object on stdout. Human-readable progress
# on stderr.
#
# Exit codes:
#   0 — success, SandboxHandle on stdout.
#   non-zero — failure, last stderr line names the problem.

set -euo pipefail

log() { printf '[local-create] %s\n' "$*" >&2; }
die() {
  printf '[local-create] ERROR: %s\n' "$*" >&2
  exit 1
}

# Validate inputs.
: "${SYMPHONY_REPO_URL:?SYMPHONY_REPO_URL is required}"
: "${SYMPHONY_DEFAULT_BRANCH:?SYMPHONY_DEFAULT_BRANCH is required}"
: "${SYMPHONY_BRANCH:?SYMPHONY_BRANCH is required}"
: "${SYMPHONY_IDENTIFIER:?SYMPHONY_IDENTIFIER is required}"

command -v git >/dev/null 2>&1 || die "git not on PATH"

WORKTREE_PATH="$(pwd)"
SANDBOX_ID="symphony-${SYMPHONY_IDENTIFIER}"
log "worktree=$WORKTREE_PATH sandbox_id=$SANDBOX_ID"

# Clone if empty; fast-forward the default branch on re-dispatch.
# All git output goes to stderr so stdout stays reserved for the final
# SandboxHandle JSON.
{
  if [ ! -d ".git" ]; then
    log "cloning $SYMPHONY_REPO_URL into $WORKTREE_PATH"
    git clone "$SYMPHONY_REPO_URL" . || die "git clone failed"
  fi

  log "syncing $SYMPHONY_DEFAULT_BRANCH from origin"
  git fetch origin || die "git fetch failed"
  git checkout "$SYMPHONY_DEFAULT_BRANCH" || die "checkout default branch failed"
  # --ff-only: refuse to rewrite history if the local default branch has
  # diverged (it shouldn't — the daemon owns this directory).
  git pull --ff-only origin "$SYMPHONY_DEFAULT_BRANCH" \
    || die "default branch diverged from origin (--ff-only refused)"

  log "switching to work branch $SYMPHONY_BRANCH"
  git checkout "$SYMPHONY_BRANCH" 2>/dev/null \
    || git checkout -b "$SYMPHONY_BRANCH" "$SYMPHONY_DEFAULT_BRANCH" \
    || die "could not checkout or create $SYMPHONY_BRANCH"
} >&2

# Start services if a compose file is present. The COMPOSE_PROJECT_NAME
# isolates this dispatch from any other compose stacks on the host.
COMPOSE_FILE=""
if [ -f "docker-compose.yml" ]; then
  COMPOSE_FILE="docker-compose.yml"
elif [ -f "compose.yml" ]; then
  COMPOSE_FILE="compose.yml"
fi

if [ -n "$COMPOSE_FILE" ]; then
  command -v docker >/dev/null 2>&1 || die "compose file present but docker not on PATH"
  log "starting services via $COMPOSE_FILE (project=$SANDBOX_ID)"
  export COMPOSE_PROJECT_NAME="$SANDBOX_ID"
  docker compose up -d || die "docker compose up failed"

  cat <<JSON
{
  "id": "$SANDBOX_ID",
  "kind": "local-docker",
  "worktree_path": "$WORKTREE_PATH",
  "exec": {
    "kind": "shell-template",
    "template": "docker compose -p $SANDBOX_ID exec app sh -c '{cmd}'"
  },
  "teardown": {
    "kind": "script",
    "script": "docker compose -p $SANDBOX_ID down -v"
  }
}
JSON
else
  log "no compose file — emitting local-shell handle"
  cat <<JSON
{
  "id": "$SANDBOX_ID",
  "kind": "local-shell",
  "worktree_path": "$WORKTREE_PATH",
  "exec": {
    "kind": "shell-template",
    "template": "cd $WORKTREE_PATH && {cmd}"
  },
  "teardown": {
    "kind": "script",
    "script": "rm -rf $WORKTREE_PATH"
  }
}
JSON
fi
