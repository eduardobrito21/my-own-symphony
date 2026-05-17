#!/usr/bin/env bash
# namespace-create.sh — provision a Namespace microVM as a sandbox.
#
# Validated 2026-05-17 against nsc v0.0.516 with real create / ssh /
# destroy / --unique_tag round-trips (Plan 17a decision log).
#
# Inputs (env vars set by the parent agent):
#   SYMPHONY_REPO_URL        — Git repo URL to clone inside the VM.
#   SYMPHONY_DEFAULT_BRANCH  — Default branch to base work on.
#   SYMPHONY_BRANCH          — Work branch to checkout/create.
#   SYMPHONY_IDENTIFIER      — Issue identifier; used as `--unique_tag`
#                              so re-dispatch reuses the same instance.
#   NSC_DURATION             — Optional. Instance TTL (default 30m).
#
# Output: a SandboxHandle JSON object on stdout. Human-readable
# progress on stderr.

set -euo pipefail

log() { printf '[namespace-create] %s\n' "$*" >&2; }
die() {
  printf '[namespace-create] ERROR: %s\n' "$*" >&2
  exit 1
}

: "${SYMPHONY_REPO_URL:?SYMPHONY_REPO_URL is required}"
: "${SYMPHONY_DEFAULT_BRANCH:?SYMPHONY_DEFAULT_BRANCH is required}"
: "${SYMPHONY_BRANCH:?SYMPHONY_BRANCH is required}"
: "${SYMPHONY_IDENTIFIER:?SYMPHONY_IDENTIFIER is required}"

DURATION="${NSC_DURATION:-30m}"
UNIQUE_TAG="symphony-${SYMPHONY_IDENTIFIER}"

# Pre-flight: nsc on PATH and authenticated.
command -v nsc >/dev/null 2>&1 \
  || die "nsc CLI not on PATH. Install from https://namespace.so/docs"
nsc auth check-login >/dev/null 2>&1 \
  || die "nsc not authenticated. Run 'nsc login' on the daemon host."

# Create (or look up) the instance. --unique_tag is idempotent per the
# 2026-05-17 probe: a second `nsc create --unique_tag X` returns the
# same instance id without provisioning a new VM.
META_FILE="$(mktemp -t nsc-meta.XXXXXX.json)"
trap 'rm -f "$META_FILE"' EXIT

log "creating (or reusing) instance tag=$UNIQUE_TAG duration=$DURATION"
nsc create \
  --bare \
  --duration "$DURATION" \
  --unique_tag "$UNIQUE_TAG" \
  --output_json_to "$META_FILE" \
  --label "symphony-id=${SYMPHONY_IDENTIFIER}" \
  >&2 \
  || die "nsc create failed"

INSTANCE_ID="$(awk -F'"' '/"cluster_id"/ { print $4; exit }' "$META_FILE")"
[ -n "$INSTANCE_ID" ] || die "nsc create did not return a cluster_id (see $META_FILE)"
log "instance_id=$INSTANCE_ID"

# Clone the repo INSIDE the VM. /workspace is conventional; we always
# fast-forward the default branch on re-dispatch.
#
# NOTE: nsc ssh does NOT propagate remote exit codes faithfully — any
# non-zero remote exit becomes local exit 1, with the real code only
# visible in stderr ("Process exited with status N"). Downstream stages
# that need the real code should use a sentinel; for this script we
# only need pass/fail, which `set -e` handles correctly.
log "preparing /workspace inside the VM"
nsc ssh "$INSTANCE_ID" -T "$(cat <<EOF_REMOTE
set -euo pipefail
if [ ! -d /workspace/.git ]; then
  rm -rf /workspace
  git clone "$SYMPHONY_REPO_URL" /workspace
fi
cd /workspace
git fetch origin
git checkout "$SYMPHONY_DEFAULT_BRANCH"
git pull --ff-only origin "$SYMPHONY_DEFAULT_BRANCH"
git checkout "$SYMPHONY_BRANCH" 2>/dev/null \
  || git checkout -b "$SYMPHONY_BRANCH" "$SYMPHONY_DEFAULT_BRANCH"
EOF_REMOTE
)" || die "remote clone/checkout failed"

# Emit the SandboxHandle. `teardown.kind = "both"` because the script
# is the primary cleanup and `--duration` is a safety net.
cat <<JSON
{
  "id": "$INSTANCE_ID",
  "kind": "namespace-devbox",
  "worktree_path": "/workspace",
  "exec": {
    "kind": "shell-template",
    "template": "nsc ssh $INSTANCE_ID -T -- {cmd}"
  },
  "teardown": {
    "kind": "both",
    "script": "nsc destroy $INSTANCE_ID --force"
  }
}
JSON
