---
# Per-repo Symphony workflow.
#
# This file is owned by the team that owns this repo. It defines:
#
#   - Which SDK tools the agent is allowed to use here.
#   - Optional model / budget overrides on top of operator defaults.
#   - Repo-specific shell hooks (typical: install deps, run tests).
#   - The prompt template the agent receives for each issue.
#
# The agent-runtime pod loads this file AFTER cloning the repo (per
# ADR 0011). The Symphony daemon itself never reads it — operator
# vs. repo-team ownership boundary.

agent:
  # Which SDK tools the agent may use in this repo. Conservative by
  # default: read + edit + bash + tracker writes. Add `Glob` / `Grep`
  # if the agent needs them for searching.
  allowed_tools:
    - Bash
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - mcp__linear__linear_graphql

  # Optional repo-side overrides. The pod takes:
  #   - model:         repo wins
  #   - max_turns:     min(operator_cap, repo_cap)
  #   - max_budget_usd: min(operator_cap, repo_cap)
  #
  # model: claude-sonnet-4-6     # uncomment to override
  # max_turns: 10
  # max_budget_usd: 2.00

hooks:
  # Runs INSIDE the pod, before the agent's first turn. Standard
  # pattern: install deps + checkout the per-issue branch. The
  # `SYMPHONY_BRANCH` / `SYMPHONY_DEFAULT_BRANCH` env vars are set
  # by the agent-runtime from the dispatch envelope (Plan 11).
  before_run: |
    set -euo pipefail
    cd /workspace
    git config user.email "${GIT_AUTHOR_EMAIL:-symphony@local}"
    git config user.name "${GIT_AUTHOR_NAME:-Symphony Agent}"
    git fetch origin
    if git ls-remote --exit-code origin "$SYMPHONY_BRANCH" >/dev/null 2>&1; then
      git checkout "$SYMPHONY_BRANCH"
      git pull --rebase origin "$SYMPHONY_BRANCH"
    else
      git checkout -b "$SYMPHONY_BRANCH" "origin/$SYMPHONY_DEFAULT_BRANCH"
    fi
    pnpm install --prefer-frozen-lockfile

  # Optional. Runs after a turn completes (success or failure).
  # Failures here are logged and ignored (per spec §9.4).
  # after_run: |
  #   echo "turn done"
---

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}

Description:
{{ issue.description | default: "(no description)" }}

Labels:
{% for l in issue.labels %}- {{ l }}
{% endfor %}

The issue details above are already authoritative for this turn. Do not make
a separate read-only Linear call just to inspect the same issue before acting.

When you start work, post a brief comment on this issue summarizing
the plan. Include the marker `<!-- symphony:starting-work issue={{ issue.identifier }} -->`
in the comment so re-dispatches can detect that work has already begun
and skip the duplicate post.

Make the requested changes, run tests (`pnpm test`), commit, and push
the branch. Then run `symphony-pr-ensure` to open or update the PR.
Post a closing comment with the PR URL (include the marker
`<!-- symphony:completed issue={{ issue.identifier }} -->`) and
transition the issue to `Done`.

If you get stuck or the change is out of scope, post a comment
explaining why and transition to `Cancelled` rather than leaving the
issue in `In Progress` (the orchestrator would keep dispatching new
turns every poll interval).
