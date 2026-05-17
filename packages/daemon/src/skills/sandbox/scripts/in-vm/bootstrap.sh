#!/usr/bin/env bash
# bootstrap.sh — one-shot, idempotent per-microVM setup (Plan 18c).
#
# Runs as root via `nsc ssh <id> -T -- bash /root/bootstrap.sh`
# right after `namespace-create.sh` POSTs CreateInstance. Steps:
#
#   1. Create a non-root `symphony` user (uid 1000).
#      Reason: `claude --dangerously-skip-permissions` refuses to
#      run under uid 0. Same constraint Plan 18b worked around with
#      a non-root container USER; on a bare microVM we create the
#      user ourselves.
#
#   2. Create + chown the well-known dirs we'll write into:
#      /workspace (the cloned target repo) and /opt/symphony
#      (per-dispatch bundle: skills + dispatch.sh).
#
#   3. Install the claude CLI as the symphony user. The installer
#      drops binaries under $HOME/.local/bin or $HOME/.claude/bin
#      (version-dependent); both are on the user's PATH via the
#      ~/.bashrc the installer writes.
#
# Idempotent: re-running the script on the same microVM (e.g., a
# re-dispatch with the same `uniqueTag`) skips work that's already
# done. `useradd` no-ops on existing user; `mkdir -p` no-ops on
# existing dirs; the claude installer is re-runnable.

set -euo pipefail

log() { printf '[bootstrap] %s\n' "$*" >&2; }
die() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

# Wolfi 6.16 (the bare-microVM base) does NOT pre-install
# `useradd`. Caught during the EDU-26 smoke (2026-05-17). The
# `shadow` apk package provides it; idempotent install via apk —
# fast (~3s) when missing, near-instant (~200ms) on re-dispatch.
[ "$(id -u)" -eq 0 ] || die "bootstrap.sh must run as root (got uid=$(id -u))"

if ! command -v useradd >/dev/null 2>&1; then
  log "useradd missing; apk add shadow"
  apk add --no-cache shadow >&2 || die "apk add shadow failed"
fi

# Wolfi pre-installs git/curl/jq/bash, but NOT gh. @ci's
# `ci-commit-push-pr.sh` requires `gh` for `gh pr create`. Caught
# during the EDU-32 smoke 2026-05-18 (the agent saw the missing
# binary and bailed out at @ci stage).
if ! command -v gh >/dev/null 2>&1; then
  log "gh missing; apk add gh"
  apk add --no-cache gh >&2 || die "apk add gh failed"
fi

# 1) Create symphony user (uid 1000), idempotent.
if id symphony >/dev/null 2>&1; then
  log "symphony user already exists (skipping useradd)"
else
  log "creating symphony user (uid 1000)"
  useradd --create-home --shell /bin/bash --uid 1000 symphony \
    || die "useradd symphony failed"
fi

# 2) Per-dispatch dirs. /workspace gets the cloned repo;
#    /opt/symphony gets the skills tree + dispatch.sh.
log "creating /workspace and /opt/symphony"
mkdir -p /workspace /opt/symphony
chown -R symphony:symphony /workspace /opt/symphony

# 3) Install claude CLI as symphony. Skip if already present from
#    a previous bootstrap on this microVM.
#
# The installer drops binaries under ~/.local/bin or ~/.claude/bin
# (version-dependent) and writes PATH exports into ~/.bashrc.
# `su -c '<cmd>'` runs a non-login non-interactive shell that does
# NOT source ~/.bashrc, so we always set PATH explicitly when
# invoking claude. We also force HOME=/home/symphony so the
# installer + the runtime claude both write under symphony's home
# (`su -p` preserves the caller's HOME, which is /root for us;
# claude silently fails on EPERM trying to access /root/.claude/.
# Caught during the EDU-29 smoke probe 2026-05-18). Same env trick
# the deleted Plan-18b Dockerfile used at the image level.
# Prepend claude install dirs to $PATH (don't replace) — Wolfi
# puts standard tools in /sbin, not /usr/bin, and the inherited
# $PATH already has the right Wolfi dirs. Caught EDU-31 smoke
# 2026-05-18 (sub-agent @ci couldn't find `gh` after we wiped its
# PATH).
CLAUDE_ENV='export HOME=/home/symphony; export PATH=/home/symphony/.local/bin:/home/symphony/.claude/bin:$PATH;'
if su symphony -c "$CLAUDE_ENV command -v claude >/dev/null 2>&1"; then
  log "claude CLI already installed (skipping)"
else
  log "installing claude CLI as symphony user"
  su symphony -c "$CLAUDE_ENV curl -fsSL https://claude.ai/install.sh | bash" \
    || die "claude installer failed"
fi

# 4) Verify claude runs (cheap sanity check; fails loud if the
#    install put binaries somewhere unexpected, or claude can't
#    reach the API, or HOME isn't writable).
log "verifying claude CLI"
su symphony -c "$CLAUDE_ENV claude --version" >&2 \
  || die "claude --version failed after install"

# 5) Verify docker daemon is up — Plan 21's @env-up depends on it.
#    Cheap insurance against a future Namespace platform update
#    that stops pre-running dockerd; we'd rather fail loud here
#    than have @env-up surface an opaque error later.
log "verifying docker daemon"
docker info >/dev/null 2>&1 \
  || die "docker daemon not available on this microVM (Plan 21 prereq broken)"

log "bootstrap complete"
