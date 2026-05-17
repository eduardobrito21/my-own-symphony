#!/usr/bin/env bash
# local-teardown.sh — clean up a local-docker (or local-shell) sandbox.
#
# Inputs (env vars):
#   SYMPHONY_SANDBOX_ID      — the `id` field of the SandboxHandle that
#                              local-create.sh emitted (e.g.
#                              symphony-EDU-13).
#   SYMPHONY_WORKTREE_PATH   — the `worktree_path` field (only used for
#                              local-shell; ignored for local-docker).
#
# This script is conservative: if the compose project or directory
# doesn't exist, that's a success (idempotent cleanup).

set -euo pipefail

log() { printf '[local-teardown] %s\n' "$*" >&2; }

: "${SYMPHONY_SANDBOX_ID:?SYMPHONY_SANDBOX_ID is required}"

# Try docker compose teardown first. Non-zero is okay — a local-shell
# sandbox never had a compose project.
if command -v docker >/dev/null 2>&1; then
  log "docker compose down -p $SYMPHONY_SANDBOX_ID"
  docker compose -p "$SYMPHONY_SANDBOX_ID" down -v 2>/dev/null || true
fi

# For local-shell, the worktree directory IS the disposable artifact.
# The daemon's workspace manager owns the parent directory; we only
# clean the worktree if it was passed in.
if [ "${SYMPHONY_WORKTREE_PATH:-}" != "" ] && [ -d "$SYMPHONY_WORKTREE_PATH" ]; then
  log "removing worktree $SYMPHONY_WORKTREE_PATH"
  rm -rf "$SYMPHONY_WORKTREE_PATH"
fi

log "done"
