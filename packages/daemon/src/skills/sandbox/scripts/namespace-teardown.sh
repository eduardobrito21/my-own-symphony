#!/usr/bin/env bash
# namespace-teardown.sh — destroy a Namespace microVM sandbox.
#
# Inputs (env vars):
#   SYMPHONY_SANDBOX_ID — the `id` from namespace-create.sh's
#                         SandboxHandle (e.g. tspga6c1sedr4).
#
# Idempotent: destroying an already-destroyed instance is a success.
# The instance's --duration is a safety net if this script never runs.

set -euo pipefail

log() { printf '[namespace-teardown] %s\n' "$*" >&2; }

: "${SYMPHONY_SANDBOX_ID:?SYMPHONY_SANDBOX_ID is required}"

if ! command -v nsc >/dev/null 2>&1; then
  log "nsc not on PATH — relying on instance duration for cleanup"
  exit 0
fi

log "destroying instance $SYMPHONY_SANDBOX_ID"
# --force skips the confirmation prompt. Failures here are surfaced but
# don't abort — the instance's --duration will reap it eventually.
nsc destroy "$SYMPHONY_SANDBOX_ID" --force 2>&1 || \
  log "nsc destroy returned non-zero (instance may already be gone or be reaped by duration)"

log "done"
