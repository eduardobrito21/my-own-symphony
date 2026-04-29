---
# Symphony WORKFLOW for the Plan 07 Claude smoke against a real Linear
# issue. See examples/linear/README.md for setup notes.
#
# IMPORTANT — running this against the live Anthropic API spends real
# money and writes real comments to a real Linear issue. The defaults
# below are tuned for ONE controlled smoke run:
#   - polling slow enough that you can hit Ctrl-C between daemon turns
#   - max_turns: 1 so the daemon runs one end-to-end agent turn per dispatch
#   - active_states includes "In Progress" so the agent's own first
#     transition does not cancel the in-flight worker
#   - max_concurrent_agents: 1 so concurrent issues queue rather than
#     fan out
#
# When you want to iterate freely (e.g. against a fake tracker fixture
# in dev), bump `polling.interval_ms` back down.

tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: c58e6fc4ca75
  # MUST include "In Progress" — the agent transitions Todo→In
  # Progress as the FIRST action of its turn (per the prompt body
  # below), and SPEC §8.5 reconciliation cancels in-flight workers
  # whose issue leaves `active_states`. With only `[Todo]` here the
  # agent's own transition triggers a self-cancel mid-turn, killing
  # the run before it can post any work-product comments. Lesson
  # learned the hard way during smoke run #2 (2026-04-29).
  #
  # Stop condition: Ctrl-C after the agent posts the closing comment,
  # OR add an instruction to the prompt to move the issue to Done
  # (terminal state) once finished.
  active_states: [Todo, 'In Progress']
  terminal_states: [Done, Cancelled, Canceled, Duplicate, Closed]

polling:
  # Slow enough to give you a real chance to Ctrl-C between turns.
  # 5000 was Plan 06's value (MockAgent — free, fast). Real Claude is
  # neither.
  interval_ms: 30000

workspace:
  # OUTSIDE the repo so we don't accidentally commit per-issue dirs.
  root: /tmp/symphony-linear-test-workspaces

agent:
  # To go back to the offline mock for development, switch to:
  #   kind: mock
  kind: claude

  # Haiku is the safe default for low-cost tracker automation.
  model: claude-haiku-4-5

  # Extended thinking can dominate cost for simple Linear tasks.
  thinking:
    type: disabled

  max_concurrent_agents: 1
  # Symphony turn limit: one complete agent run, not one Linear tool call.
  max_turns: 1
  max_budget_usd: 1
  # 2 minutes — plenty of headroom for one Claude turn that may make
  # 2-3 linear_graphql round trips. The Plan 06 value (5000) was
  # MockAgent-tier and would expire mid-turn for real Claude.
  turn_timeout_ms: 120000
  read_timeout_ms: 30000
  # 0 disables stall detection (per SPEC §5.3.6). Disabled for the
  # smoke because the SDK's normal "thinking" pauses can otherwise
  # look like a stall.
  stall_timeout_ms: 0
  max_retry_backoff_ms: 60000

hooks:
  timeout_ms: 10000
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
Keep Linear tool usage minimal; prefer the smallest number of GraphQL calls
needed to post comments and transition state.

When you need to do multiple Linear writes, batch them into one GraphQL
operation whenever possible. For example, one mutation can create the opening
comment and move the issue to `In Progress`; another can create the closing
comment and move the issue to `Done`.

When you start work, post a brief comment on this issue summarizing
the plan, then move it to `In Progress`.

When you finish or get stuck, post a closing comment AND move the issue to `Done` (or `Cancelled` if you're abandoning) — leaving it in `In Progress` causes the orchestrator to keep dispatching new turns every poll interval.

Use the `mcp__linear__linear_graphql` tool for all Linear writes —
see your system prompt for the operating rules.
