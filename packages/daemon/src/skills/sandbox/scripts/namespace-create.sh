#!/usr/bin/env bash
# namespace-create.sh — provision a Namespace bare microVM as a
# sandbox (Plan 18c).
#
# How it differs from the Plan 18b baseline:
#   - No container layer. The CreateInstance POST has no `containers`
#     field; we get a bare microVM (Wolfi 6.16, kernel 6.16.9) with
#     root, full capabilities, seccomp off, and dockerd already
#     running.
#   - No vault. Credentials don't ride through `envVars[].fromSecretId`
#     anymore; they ride through `nsc ssh -T` stdin per-stage at
#     dispatch time. Two consequences for this script:
#       a) `namespace-create.sh` itself only needs GITHUB_TOKEN at
#          provision time (for the clone) — piped over stdin into
#          the in-VM clone helper, same hygiene as runtime dispatches.
#       b) The hardcoded NAMESPACE_SECRET_* constants from 18b are
#          gone, along with the operator step of registering vault
#          secrets in the Namespace UI.
#   - No pre-built `symphony-agent` image. The microVM boots with
#     git/gh/curl/bash/jq/docker pre-installed; we add a symphony
#     user + claude CLI per-microVM via bootstrap.sh.
#
# Validated against the 2026-05-17 probe (instance icl1mthslod5k,
# destroyed). See Plan 18c decision log for the probe results.
#
# Inputs (env vars set by the parent agent at @sandbox dispatch time):
#   SYMPHONY_REPO_URL        — Git repo URL to clone inside the VM.
#   SYMPHONY_DEFAULT_BRANCH  — Default branch to base work on.
#   SYMPHONY_BRANCH          — Work branch to checkout/create.
#   SYMPHONY_IDENTIFIER      — Issue identifier; used as `uniqueTag`.
#   NSC_DURATION             — Optional. Instance TTL (default 30m).
#
# Inputs read from the daemon's own env (passed through to the VM
# via stdin, never written to disk):
#   GITHUB_TOKEN             — Optional, for private repo clone.
#
# Operator-side prerequisites (one-time):
#   - `nsc login` on the daemon host. That's it. No image to build,
#     no vault secrets to register.
#
# Output: a SandboxHandle JSON object on stdout. Progress on stderr.

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

# Operator-specific. Regional API endpoint; hardcoded for v1 dogfood.
# Migrate to symphony.yaml when there's a second operator.
NAMESPACE_API_URL="https://api.iad4.namespaceapis.com"
DURATION="${NSC_DURATION:-30m}"
UNIQUE_TAG="symphony-${SYMPHONY_IDENTIFIER}"

# Pre-flight: nsc on PATH, authenticated, plus curl + jq for the
# API call.
command -v nsc >/dev/null 2>&1 \
  || die "nsc CLI not on PATH. Install from https://namespace.so/docs"
command -v curl >/dev/null 2>&1 \
  || die "curl not on PATH"
command -v jq >/dev/null 2>&1 \
  || die "jq not on PATH"
nsc auth check-login >/dev/null 2>&1 \
  || die "nsc not authenticated. Run 'nsc login' on the daemon host."

# Where the in-VM scripts live on the daemon side. Relative to this
# script so dev (src/) and built (dist/) layouts both work.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_PATH="$SCRIPT_DIR/in-vm/bootstrap.sh"
CLONE_SCRIPT_PATH="$SCRIPT_DIR/in-vm/clone-and-checkout.sh"
WRAPPER_PATH="$SCRIPT_DIR/in-vm/dispatch.sh"
SKILLS_PARENT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$BOOTSTRAP_PATH" ] || die "bootstrap missing: $BOOTSTRAP_PATH"
[ -f "$CLONE_SCRIPT_PATH" ] || die "clone helper missing: $CLONE_SCRIPT_PATH"
[ -f "$WRAPPER_PATH" ] || die "wrapper missing: $WRAPPER_PATH"
[ -d "$SKILLS_PARENT_DIR/skills" ] || die "skills dir missing: $SKILLS_PARENT_DIR/skills"

# 1) Short-lived API token. `generate-dev-token` issues a bearer
#    we can pass to the REST endpoint without exposing the daemon's
#    long-lived nsc keychain entry directly.
TOKEN_FILE="$(mktemp -t symphony-nsc-token.XXXXXX)"
SKILLS_TAR=""
REQ_FILE=""
cleanup() {
  [ -n "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE"
  [ -n "$SKILLS_TAR" ] && rm -f "$SKILLS_TAR"
  [ -n "$REQ_FILE" ] && rm -f "$REQ_FILE"
  return 0
}
trap cleanup EXIT

log "issuing dev API token"
nsc auth generate-dev-token --output_to "$TOKEN_FILE" >&2 \
  || die "nsc auth generate-dev-token failed"
[ -s "$TOKEN_FILE" ] || die "dev token file is empty"

# 2) POST CreateInstance — bare microVM, no containers, no
#    envVars[] declarations. `bare: true` plus an empty containers
#    field gives us a microVM we ssh into directly (no
#    --container_name).
REQ_FILE="$(mktemp -t symphony-create-req.XXXXXX.json)"
cat >"$REQ_FILE" <<EOF
{
  "duration": "${DURATION}",
  "bare": true,
  "uniqueTag": "${UNIQUE_TAG}",
  "label": {"symphony-id": "${SYMPHONY_IDENTIFIER}"}
}
EOF

log "creating bare microVM (uniqueTag=$UNIQUE_TAG, duration=$DURATION)"
CREATE_RESP="$(
  curl -fsS -X POST \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    -H "Content-Type: application/json" \
    -d @"$REQ_FILE" \
    "$NAMESPACE_API_URL/namespace.cloud.compute.v1beta.ComputeService/CreateInstance"
)" || die "CreateInstance API call failed"

INSTANCE_ID="$(echo "$CREATE_RESP" | jq -r '.metadata.instanceId // empty')"
[ -n "$INSTANCE_ID" ] || die "CreateInstance returned no instanceId: $CREATE_RESP"
log "instance_id=$INSTANCE_ID"

# 3) Wait for the microVM to be reachable. SSH without
#    --container_name lands on the host shell directly.
log "waiting for microVM to be reachable"
DEADLINE=$(($(date +%s) + 120))
until nsc ssh "$INSTANCE_ID" -T -- /bin/true 2>/dev/null; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "microVM never came up within 120s"
  sleep 3
done
log "microVM reachable"

# 4) Bootstrap: create symphony user, install claude CLI, verify
#    docker daemon. Idempotent (re-dispatch on same uniqueTag).
log "uploading bootstrap script"
nsc instance upload "$INSTANCE_ID" \
  "$BOOTSTRAP_PATH" /root/bootstrap.sh --mkdir >&2 \
  || die "upload of bootstrap.sh failed"

log "running bootstrap"
nsc ssh "$INSTANCE_ID" -T -- bash /root/bootstrap.sh >&2 \
  || die "bootstrap failed"

# 5) Upload the clone helper, then clone the target repo. The
#    GITHUB_TOKEN ships over `nsc ssh` stdin (in-memory only) — the
#    clone helper drains stdin for it before running git.
log "uploading clone-and-checkout helper"
nsc instance upload "$INSTANCE_ID" \
  "$CLONE_SCRIPT_PATH" /opt/symphony/clone-and-checkout.sh --mkdir >&2 \
  || die "upload of clone-and-checkout.sh failed"

# Run the clone AS ROOT. We could `su symphony -c ...` to land the
# files as 1000:1000 directly, but that re-introduces the same
# whitespace-splitting gotcha `nsc ssh` has with its argv (`su -c
# "bash …"` is multi-token; `nsc ssh` splits on whitespace and
# only the first token reaches argv). Caught during the EDU-30
# smoke 2026-05-18: the broken `su -c` invocation silently no-op'd
# and the script reported success.
# Workaround: clone as root, then chown /workspace recursively to
# symphony. The argv stays a clean four-element vector that nsc
# ssh forwards intact.
log "cloning repo into /workspace (as root, stdin-piped GITHUB_TOKEN)"
nsc ssh "$INSTANCE_ID" -T -- \
  bash /opt/symphony/clone-and-checkout.sh \
  "$SYMPHONY_REPO_URL" "$SYMPHONY_DEFAULT_BRANCH" "$SYMPHONY_BRANCH" <<EOF >&2 \
  || die "clone/checkout failed"
GITHUB_TOKEN=${GITHUB_TOKEN:-}
EOF

# Sanity-check the clone actually landed — `nsc ssh` exit codes
# can lie on the remote side; we'd rather fail loud here than send
# downstream stages into an empty worktree.
log "verifying /workspace has a .git directory"
nsc ssh "$INSTANCE_ID" -T -- test -d /workspace/.git >&2 \
  || die "post-clone sanity check failed — /workspace/.git missing"

log "chowning /workspace to symphony"
nsc ssh "$INSTANCE_ID" -T -- chown -R symphony:symphony /workspace >&2 \
  || die "chown of /workspace failed"

# 6) Upload the daemon's current skills tree to /opt/symphony/skills/.
#    nsc instance upload is single-file, so we tar locally → upload
#    archive → extract in VM. Extracted as root then chown'd to
#    symphony so the per-stage `su symphony -c claude …` invocations
#    can read the SKILL.md bodies.
log "uploading skills bundle"
SKILLS_TAR="$(mktemp -t symphony-skills.XXXXXX.tar.gz)"
tar -czf "$SKILLS_TAR" -C "$SKILLS_PARENT_DIR" skills \
  || die "tar of skills failed"
nsc instance upload "$INSTANCE_ID" \
  "$SKILLS_TAR" /opt/symphony/skills.tar.gz --mkdir >&2 \
  || die "upload of skills tarball failed"
# Two single-command ssh calls instead of `bash -c` with multiple
# statements — `nsc ssh` doesn't pass through a shell.
nsc ssh "$INSTANCE_ID" -T -- \
  tar -xzf /opt/symphony/skills.tar.gz -C /opt/symphony/ >&2 \
  || die "extract of skills tarball failed"
nsc ssh "$INSTANCE_ID" -T -- \
  rm -f /opt/symphony/skills.tar.gz >&2 \
  || die "cleanup of skills tarball failed"
nsc ssh "$INSTANCE_ID" -T -- \
  chown -R symphony:symphony /opt/symphony/skills >&2 \
  || die "chown of skills tree failed"

# 7) Upload the in-VM dispatch wrapper.
log "uploading dispatch wrapper to /opt/symphony/dispatch.sh"
nsc instance upload "$INSTANCE_ID" \
  "$WRAPPER_PATH" /opt/symphony/dispatch.sh --mkdir >&2 \
  || die "upload of dispatch.sh failed"

log "symphony bundle ready (bootstrap done; skills + dispatch.sh in place)"

# 8) Emit the SandboxHandle. `exec.template` invokes commands inside
#    the microVM via `nsc ssh -T --` (no --container_name).
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
    "script": "nsc instance destroy $INSTANCE_ID --force"
  }
}
JSON
