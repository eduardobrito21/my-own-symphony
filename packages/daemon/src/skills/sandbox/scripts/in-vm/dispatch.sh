#!/usr/bin/env bash
# In-VM wrapper for Symphony sub-agent dispatch (Plan 18c).
#
# Lives inside the Namespace bare microVM at /opt/symphony/dispatch.sh.
# Invoked over `nsc ssh -T` (no --container_name — Plan 18c dropped the
# container layer) by the daemon's parent agent to run a sub-agent
# (@planner / @coder / @curator / @ci) via the `claude` CLI.
#
# Contract:
#   /opt/symphony/dispatch.sh <subagent-name>  < <stdin-payload>
#
# Argv:
#   $1 — sub-agent name (must match a dir under /opt/symphony/skills/)
#
# Stdin payload (two segments, separated by the literal line
# `---SYMPHONY-INPUTS---`):
#
#   Segment 1 — env vars, one per line in `KEY=value` form:
#     ANTHROPIC_API_KEY=...     (required, consumed by `claude`)
#     GITHUB_TOKEN=...          (optional, used by @ci)
#     # extra KEY=value lines are exported as-is
#     ---SYMPHONY-INPUTS---
#
#   Segment 2 — the sub-agent's input body, verbatim. Any text:
#   labelled list, JSON, multi-line prose. Passed through to claude
#   as the user prompt body unchanged. No shell parsing.
#
# Why this shape (and not `<inputs-json>` as argv):
#   Per-stage inputs include arbitrary issue text — apostrophes,
#   backticks, dollars, quotes — which makes argv-with-shell-quoting
#   a footgun for the calling agent. Splitting stdin into "env until
#   sentinel, then inputs body" sidesteps quoting entirely on the
#   caller side (the parent can use printf for env-line expansion
#   and a single-quoted heredoc for the inputs body).
#
# Execution model:
#   The script itself runs as root (that's how `nsc ssh -T -- bash …`
#   lands in a Plan 18c bare microVM). We export the stdin secrets in
#   root's env, then drop to the non-root `symphony` user (bootstrap.sh
#   created it) for the claude invocation — `claude --dangerously-skip-
#   permissions` refuses uid 0. We use `su -p` to preserve the env we
#   just populated.
#
# Output (stdout):
#   The final assistant reply from `claude -p` (default text mode).
#   Contains the structured JSON fence the daemon's post-hoc validators
#   scan for. The parent reads this via its `Bash` tool and threads the
#   JSON onward to the next stage.
#
# Exit code:
#   Mirrors claude's. Non-zero = sub-agent failed; parent skips
#   downstream stages.
#
# Stderr: wrapper logging only — daemon may capture for debugging.

set -uo pipefail

log() { echo "[dispatch.sh] $*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

[ $# -eq 1 ] || die "usage: $0 <subagent-name>  (inputs come from stdin)"

SUBAGENT="$1"

# Refuse unknown sub-agents. @sandbox is excluded — it runs in the
# daemon (Plan 18b Decision 8), never in the VM.
case "$SUBAGENT" in
  planner | coder | curator | ci) ;;
  sandbox) die "@sandbox runs in the daemon, not the sandbox" ;;
  *) die "unknown sub-agent: $SUBAGENT" ;;
esac

SKILL_MD="/opt/symphony/skills/$SUBAGENT/SKILL.md"
[ -r "$SKILL_MD" ] || die "skill markdown not found: $SKILL_MD"

# Drain segment 1 (env vars) until the sentinel line.
# - Blank lines tolerated.
# - `# …` comment lines tolerated.
# - Anything else must be `KEY=value`; we export it.
# - Sentinel switches us to segment 2 (inputs body).
#
# Why stdin (not nsc ssh env / argv): `nsc ssh -T --` doesn't
# forward arbitrary env vars (it execs argv via the command-service,
# not a login shell). Stdin is the only narrow channel that delivers
# data in-memory without it landing on argv, disk, or any log we
# don't control.
INPUTS_SENTINEL='---SYMPHONY-INPUTS---'
saw_sentinel=0
while IFS= read -r line; do
  if [ "$line" = "$INPUTS_SENTINEL" ]; then
    saw_sentinel=1
    break
  fi
  case "$line" in
    '') continue ;;
    \#*) continue ;;
    *=*) export "$line" ;;
    *) die "stdin line before sentinel must be KEY=value: $line" ;;
  esac
done
[ "$saw_sentinel" -eq 1 ] || die "stdin missing $INPUTS_SENTINEL separator"

# Segment 2: the rest of stdin is the inputs body, verbatim.
USER_INPUTS="$(cat)"

# Hard requirement (the daemon's Bash dispatch template includes
# it as the first line of the heredoc). Fail loud here rather than
# letting `claude` emit an opaque auth error later.
[ -n "${ANTHROPIC_API_KEY:-}" ] \
  || die "ANTHROPIC_API_KEY not received over stdin (parent dispatch template misconfigured?)"

# Per-sub-agent tool allowlist. Mirrors packages/daemon/src/agent/
# pipeline/sub-agents.ts SUB_AGENT_TOOLS — must stay in sync.
case "$SUBAGENT" in
  planner) ALLOWED_TOOLS="Bash,Read,Write,Glob,Grep" ;;
  coder) ALLOWED_TOOLS="Bash,Read,Write,Edit,Glob,Grep" ;;
  curator) ALLOWED_TOOLS="Bash,Read,Write,Edit,Glob,Grep" ;;
  ci) ALLOWED_TOOLS="Bash,Read" ;;
esac

# User prompt: a small framing line + the inputs body the parent
# assembled. The agent reads its own SKILL.md (via
# --append-system-prompt) for behavior, then parses the inputs from
# the user prompt body — same labelled-list format the agent sees in
# the local-* dispatch path.
USER_PROMPT="You are executing the @${SUBAGENT} sub-agent. Your inputs:

${USER_INPUTS}

Read the system prompt for your skill's instructions. Follow them and emit your structured output as documented."

# Worktree must exist (namespace-create.sh's clone step put the
# repo here). The su we're about to launch will `cd` to this dir
# inside its login shell.
WORKTREE="/workspace"
[ -d "$WORKTREE" ] || die "worktree not found: $WORKTREE"

# Read SKILL.md content once so we don't have to plumb the path
# through the `su -p` boundary. Symphony-user's claude needs the
# body as a single --append-system-prompt argument.
SKILL_BODY="$(cat "$SKILL_MD")"

log "invoking claude for @${SUBAGENT} (allowed-tools: ${ALLOWED_TOOLS})"

# Drop to symphony for claude. Why:
#  - `claude --dangerously-skip-permissions` hard-refuses uid 0.
#  - `su -p` (or `--preserve-environment`) keeps the exported
#    ANTHROPIC_API_KEY / GITHUB_TOKEN visible to the child shell.
#  - We pass the SKILL body, allowed tools, inputs body, and user
#    prompt through env vars (also preserved by `-p`) — the child
#    shell reads them by name instead of having them on argv.
export SYMPHONY_SKILL_BODY="$SKILL_BODY"
export SYMPHONY_ALLOWED_TOOLS="$ALLOWED_TOOLS"
export SYMPHONY_USER_PROMPT="$USER_PROMPT"
export SYMPHONY_WORKTREE="$WORKTREE"

# claude's exit code propagates as our own. The dispatch script is
# the leaf process the daemon's Bash tool inspects.
#
# Two env tweaks for the child shell:
# - `HOME=/home/symphony`: `su -p` preserves env including HOME,
#   which still points at root's home. claude tries to read/write
#   its own config under `$HOME/.claude/` and silently fails (exit
#   0, zero stdout) on EPERM. Caught during the EDU-29 smoke probe
#   2026-05-18.
# - `PATH`: `su -c` runs a non-login non-interactive shell that
#   does NOT source ~/.bashrc, so the claude installer's PATH
#   tweaks aren't visible by default. Hardcode the install dirs
#   (matches the deleted Plan-18b Dockerfile's `ENV PATH`).
# PATH note: we **prepend** the claude install dirs to the
# existing $PATH rather than replacing it. Wolfi puts standard
# tools (`git`, `gh`, `curl`, `jq`) in `/sbin`, not the
# Debian-y `/usr/bin`; the inherited $PATH already includes the
# right Wolfi dirs. Replacing with a hand-rolled `/usr/local/bin:
# /usr/bin:/bin` would drop `gh` etc. and break @ci. Caught
# during the EDU-31 smoke 2026-05-18.
su -p symphony -c '
  export HOME=/home/symphony
  export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"
  cd "$SYMPHONY_WORKTREE"
  exec claude --print \
              --append-system-prompt "$SYMPHONY_SKILL_BODY" \
              --allowed-tools "$SYMPHONY_ALLOWED_TOOLS" \
              --bare \
              --dangerously-skip-permissions \
              "$SYMPHONY_USER_PROMPT"
'
exit $?
