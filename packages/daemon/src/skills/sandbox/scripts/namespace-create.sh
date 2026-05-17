#!/usr/bin/env bash
# namespace-create.sh — provision a Namespace microVM + agent container
# as a sandbox (Plan 18b, vault-native).
#
# How it differs from the Plan 17a baseline:
#   - We no longer call `nsc create --bare` and ssh into a host.
#   - Instead we POST `ComputeService.CreateInstance` directly to
#     Namespace's API, declaring one container ("agent") that uses
#     our pre-built `symphony-agent` image and pulls
#     ANTHROPIC_API_KEY + GITHUB_TOKEN from the workspace vault via
#     `envVars[].fromSecretId`. No secret ever touches disk in the
#     daemon or in the VM.
#   - The container's image carries claude CLI + git + gh; we don't
#     install them per-dispatch.
#   - We still upload the daemon's current skills tree + the in-VM
#     wrapper (`dispatch.sh`) at provision time, so SKILL.md updates
#     ship with the daemon (not with an image rebuild).
#
# Validated 2026-05-17 against nsc v0.0.516. `imageRef` (not `image`)
# is the load-bearing field name discovered during the smoke probe —
# `image` is silently dropped by the API.
#
# Inputs (env vars set by the parent agent at @sandbox dispatch time):
#   SYMPHONY_REPO_URL        — Git repo URL to clone inside the agent
#                              container.
#   SYMPHONY_DEFAULT_BRANCH  — Default branch to base work on.
#   SYMPHONY_BRANCH          — Work branch to checkout/create.
#   SYMPHONY_IDENTIFIER      — Issue identifier; used as `uniqueTag`.
#   NSC_DURATION             — Optional. Instance TTL (default 30m).
#
# Operator-side prerequisites (one-time):
#   - `nsc login` (daemon's nsc must be authenticated)
#   - Build + push the agent image:
#       nsc build docker -f symphony-agent.Dockerfile \
#                 --name symphony-agent --push
#   - Create vault secrets in the Namespace UI:
#       ANTHROPIC_API_KEY  → secret object id
#       GITHUB_TOKEN       → secret object id
#     and paste those ids below (NAMESPACE_SECRET_*).
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

# Operator-specific. Hardcoded for v1 dogfood. Migrate to symphony.yaml
# config once we have a second operator or a real reason to.
NAMESPACE_API_URL="https://api.iad4.namespaceapis.com"
NAMESPACE_IMAGE_REF="nscr.io/4d48p47qhbdbi/symphony-agent:latest"
NAMESPACE_SECRET_ANTHROPIC_API_KEY="sec_u93fk4ekq8"
NAMESPACE_SECRET_GITHUB_TOKEN="sec_5bukm4tp80"
DURATION="${NSC_DURATION:-30m}"
UNIQUE_TAG="symphony-${SYMPHONY_IDENTIFIER}"

# Pre-flight: nsc on PATH and authenticated (we use `nsc auth
# generate-dev-token` to get a short-lived bearer for the API).
command -v nsc >/dev/null 2>&1 \
  || die "nsc CLI not on PATH. Install from https://namespace.so/docs"
command -v curl >/dev/null 2>&1 \
  || die "curl not on PATH"
command -v jq >/dev/null 2>&1 \
  || die "jq not on PATH"
nsc auth check-login >/dev/null 2>&1 \
  || die "nsc not authenticated. Run 'nsc login' on the daemon host."

# Where the wrapper + skills live on the daemon side. Relative to
# this script so dev (src/) and built (dist/) layouts both work.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_PATH="$SCRIPT_DIR/in-vm/dispatch.sh"
SKILLS_PARENT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
[ -f "$WRAPPER_PATH" ] || die "wrapper missing: $WRAPPER_PATH"
[ -d "$SKILLS_PARENT_DIR/skills" ] || die "skills dir missing: $SKILLS_PARENT_DIR/skills"

# 1) Generate a short-lived API token. We don't reuse the daemon's
#    long-lived nsc keychain entry directly — `generate-dev-token`
#    issues a per-invocation bearer we can pass to the REST endpoint.
TOKEN_FILE="$(mktemp -t symphony-nsc-token.XXXXXX)"
SKILLS_TAR=""
REQ_FILE=""
cleanup() {
  # rm -f each tmp file ONLY if its variable is non-empty; the
  # `:-/dev/null` default is wrong because /dev/null isn't rm-able
  # ("Operation not permitted").
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

# 2) POST CreateInstance. The body has one container ("agent")
#    referencing the symphony-agent image and pulling both creds
#    from the vault.
REQ_FILE="$(mktemp -t symphony-create-req.XXXXXX.json)"
cat > "$REQ_FILE" <<EOF
{
  "duration": "${DURATION}",
  "bare": true,
  "uniqueTag": "${UNIQUE_TAG}",
  "label": {"symphony-id": "${SYMPHONY_IDENTIFIER}"},
  "containers": [
    {
      "name": "agent",
      "imageRef": "${NAMESPACE_IMAGE_REF}",
      "envVars": [
        {"name": "ANTHROPIC_API_KEY", "fromSecretId": "${NAMESPACE_SECRET_ANTHROPIC_API_KEY}"},
        {"name": "GITHUB_TOKEN",      "fromSecretId": "${NAMESPACE_SECRET_GITHUB_TOKEN}"}
      ]
    }
  ]
}
EOF

log "creating instance (uniqueTag=$UNIQUE_TAG, duration=$DURATION)"
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

# 3) Wait for the agent container to be reachable. Image pull can take
#    a moment on cold caches.
log "waiting for agent container to be reachable"
DEADLINE=$(( $(date +%s) + 120 ))
until nsc ssh "$INSTANCE_ID" --container_name agent -T -- /bin/true 2>/dev/null; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "agent container never came up within 120s"
  sleep 3
done
log "agent container reachable"

# 4) Clone the target repo INSIDE the agent container.
#
# Important: `nsc ssh --container_name` does NOT pass commands
# through a shell — it splits the command string on whitespace and
# exec's argv[0] directly via the container runtime. So we can't
# inline a multi-statement script; the kernel exec would fail with
# `exec: "set": executable file not found` on the first word. Fix:
# upload a helper script (`clone-and-checkout.sh`) and exec it by
# absolute path with three positional args. Each arg is its own
# argv slot — no shell parsing involved.
#
# Discovered during the EDU-22 smoke (2026-05-17).
log "uploading clone-and-checkout helper"
CLONE_SCRIPT_PATH="$SCRIPT_DIR/in-vm/clone-and-checkout.sh"
[ -f "$CLONE_SCRIPT_PATH" ] || die "clone helper missing: $CLONE_SCRIPT_PATH"
nsc instance upload "$INSTANCE_ID" --container_name agent \
  "$CLONE_SCRIPT_PATH" /opt/symphony/clone-and-checkout.sh --mkdir >&2 \
  || die "upload of clone-and-checkout.sh failed"

# Invoke via `bash <path>` rather than relying on the executable bit:
# `nsc instance upload` writes files as root (regardless of the
# container's USER), and our non-root `symphony` user can't chmod a
# root-owned file. Bash only needs the file readable, which mode 644
# (the default upload mode) satisfies.
log "cloning repo into agent container's /workspace"
nsc ssh "$INSTANCE_ID" --container_name agent -T -- \
  bash /opt/symphony/clone-and-checkout.sh \
  "$SYMPHONY_REPO_URL" "$SYMPHONY_DEFAULT_BRANCH" "$SYMPHONY_BRANCH" >&2 \
  || die "clone/checkout inside agent container failed"

# 5) Upload the daemon's current skills tree to /opt/symphony/skills/.
#    nsc instance upload is single-file, so we tar locally → upload
#    archive → extract in container.
log "uploading skills bundle to /opt/symphony/skills/"
SKILLS_TAR="$(mktemp -t symphony-skills.XXXXXX.tar.gz)"
tar -czf "$SKILLS_TAR" -C "$SKILLS_PARENT_DIR" skills \
  || die "tar of skills failed"
nsc instance upload "$INSTANCE_ID" --container_name agent \
  "$SKILLS_TAR" /opt/symphony/skills.tar.gz --mkdir >&2 \
  || die "nsc instance upload (skills) failed"
# Two single-command ssh calls instead of `bash -c` with multiple
# statements — see the same nsc ssh quoting note in step 4 above.
nsc ssh "$INSTANCE_ID" --container_name agent -T -- \
  tar -xzf /opt/symphony/skills.tar.gz -C /opt/symphony/ >&2 \
  || die "extract of skills tarball failed"
nsc ssh "$INSTANCE_ID" --container_name agent -T -- \
  rm -f /opt/symphony/skills.tar.gz >&2 \
  || die "cleanup of skills tarball failed"

# 6) Upload the in-VM wrapper script. Same `bash <path>` invocation
#    pattern (see step 4) — we don't bother with chmod +x since the
#    parent agent invokes it via `bash /opt/symphony/dispatch.sh ...`.
log "uploading dispatch wrapper to /opt/symphony/dispatch.sh"
nsc instance upload "$INSTANCE_ID" --container_name agent \
  "$WRAPPER_PATH" /opt/symphony/dispatch.sh --mkdir >&2 \
  || die "nsc instance upload (wrapper) failed"

log "symphony bundle ready (skills + dispatch.sh; creds from vault)"

# Emit the SandboxHandle. `exec.template` now routes through the
# container, not the host: every {cmd} runs inside the agent
# container where claude/git/gh are installed and credentials are
# in env.
cat <<JSON
{
  "id": "$INSTANCE_ID",
  "kind": "namespace-devbox",
  "worktree_path": "/workspace",
  "exec": {
    "kind": "shell-template",
    "template": "nsc ssh $INSTANCE_ID --container_name agent -T -- {cmd}"
  },
  "teardown": {
    "kind": "both",
    "script": "nsc destroy $INSTANCE_ID --force"
  }
}
JSON
