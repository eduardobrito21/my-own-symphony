#!/usr/bin/env bash
# In-VM wrapper for Symphony sub-agent dispatch (Plan 18b, Decision 12).
#
# This script lives inside the Namespace microVM at
# /opt/symphony/dispatch.sh. It is invoked over `nsc ssh -T` by the
# daemon's parent agent to run a sub-agent (@planner / @coder / @ci)
# inside the sandbox via the `claude` CLI.
#
# Contract:
#   /opt/symphony/dispatch.sh <subagent-name> <inputs-json>
#
# Inputs:
#   $1 — sub-agent name (must match a dir under /opt/symphony/skills/)
#   $2 — JSON string with the per-sub-agent inputs the parent assembled
#        (e.g. issue_identifier, issue_title, sandbox_handle, plan_path
#        for @coder). The script passes this through to claude as part
#        of the user prompt; the agent's SKILL.md tells it how to parse.
#
# Env:
#   Already injected into the container's environment by Namespace's
#   vault → container plumbing (per Plan 18b Decision 4). The wrapper
#   does NOT source any file — the variables are inherited from the
#   container's own env:
#     ANTHROPIC_API_KEY  required, consumed by `claude`
#     GITHUB_TOKEN       optional, used by @ci for git push + gh
#
# Output (stdout):
#   The final assistant reply from `claude -p` (default text mode).
#   That reply contains the structured JSON fence the daemon's
#   post-hoc validators scan for. The parent agent reads this via
#   its `Bash` tool and threads the JSON onward to the next stage.
#
# Exit code:
#   Mirrors claude's exit code. Non-zero indicates the sub-agent
#   failed — the daemon's Bash tool surfaces the failure to the
#   parent, which skips downstream stages.
#
# Stderr is used for the wrapper's own logging — the daemon may capture
# it for debugging but does not parse it.

set -uo pipefail

log() { echo "[dispatch.sh] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[ $# -eq 2 ] || die "usage: $0 <subagent-name> <inputs-json>"

SUBAGENT="$1"
INPUTS_JSON="$2"

# Refuse unknown sub-agents. @sandbox is excluded — it runs in the
# daemon (Plan 18b Decision 8), never in the VM.
case "$SUBAGENT" in
  planner|coder|ci) ;;
  sandbox) die "@sandbox runs in the daemon, not the sandbox" ;;
  *) die "unknown sub-agent: $SUBAGENT" ;;
esac

SKILL_MD="/opt/symphony/skills/$SUBAGENT/SKILL.md"
[ -r "$SKILL_MD" ] || die "skill markdown not found: $SKILL_MD"

# Credentials are vault-injected by Namespace at container start.
# We don't read or write any file with secrets — we just verify
# they're present so a misconfigured `envVars` declaration fails
# loud here instead of producing a confusing `claude` error later.
[ -n "${ANTHROPIC_API_KEY:-}" ] \
  || die "ANTHROPIC_API_KEY not in container env (Plan 18b vault attachment misconfigured?)"

# Per-sub-agent tool allowlist. Mirrors packages/daemon/src/agent/pipeline/sub-agents.ts
# SUB_AGENT_TOOLS — must stay in sync. The `claude` CLI uses
# comma/space separated names; per --allowed-tools in `claude --help`.
case "$SUBAGENT" in
  planner) ALLOWED_TOOLS="Bash,Read,Write,Glob,Grep" ;;
  coder)   ALLOWED_TOOLS="Bash,Read,Write,Edit,Glob,Grep" ;;
  ci)      ALLOWED_TOOLS="Bash,Read" ;;
esac

# User prompt: a small framing line + the structured inputs the parent
# assembled. The agent reads its own SKILL.md (via --append-system-prompt)
# for behavior, then parses the inputs from the user prompt body.
USER_PROMPT="You are executing the @${SUBAGENT} sub-agent. Your inputs:

${INPUTS_JSON}

Read the system prompt for your skill's instructions. Follow them and emit your structured output as documented."

# Working directory inside the VM: this script runs from /, but the
# agent's edits target the cloned repo. The repo is at the path
# /workspace by Namespace convention (set by @sandbox's
# namespace-create.sh). cd there so relative paths in the agent's
# Bash calls land in the right place.
WORKTREE="/workspace"
[ -d "$WORKTREE" ] || die "worktree not found: $WORKTREE"
cd "$WORKTREE"

log "invoking claude for @${SUBAGENT} (allowed-tools: ${ALLOWED_TOOLS})"

# Run claude in default text output mode — emit only the final
# assistant reply on stdout. The reply contains the structured JSON
# fence the daemon's post-hoc validators (findSandboxHandleInText,
# CoderResult, CIResult, PlannerResult) already scan for.
#
# Why text mode instead of stream-json:
#   - The parent agent in the daemon reads this stdout via its Bash
#     tool. Text mode gives it the agent's natural reply directly,
#     so no NDJSON parsing is needed downstream.
#   - Streaming intermediate events is a future win (better
#     dashboard observability), not a v1 requirement.
#
# --bare skips CLAUDE.md auto-discovery, plugin sync, hooks,
# attribution etc. — perfect for a one-shot dispatch.
# --dangerously-skip-permissions is needed because we're
# non-interactive in a sandbox; the "danger" of unrestricted tool
# use is bounded by the microVM and the per-sub-agent
# --allowed-tools allowlist.
#
# claude's exit code propagates as our own (the script doesn't set
# `-e`, so a non-zero from claude won't trigger early-exit; `exit $?`
# is what the daemon's Bash tool reads). The parent's prompt
# instructs it to treat that as a sub-agent failure (skip downstream
# stages, surface in close-out).
claude --print \
       --append-system-prompt "$(cat "$SKILL_MD")" \
       --allowed-tools "$ALLOWED_TOOLS" \
       --bare \
       --dangerously-skip-permissions \
       "$USER_PROMPT"
exit $?
