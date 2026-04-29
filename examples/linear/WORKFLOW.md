---
# Symphony WORKFLOW for the Plan 07 Claude smoke against a real Linear
# issue. See examples/linear/README.md for setup notes.
#
# IMPORTANT — running this against the live Anthropic API spends real
# money and writes real comments to a real Linear issue. The defaults
# below are tuned for ONE controlled smoke run:
#   - polling slow enough that you can hit Ctrl-C between turns
#   - max_turns: 1 so the agent runs at most one turn per dispatch
#   - active_states: [Todo] only, so an issue exits eligibility as
#     soon as the agent transitions it to "In Progress"
#   - max_concurrent_agents: 1 so concurrent issues queue rather than
#     fan out
#
# When you want to iterate freely (e.g. against a fake tracker fixture
# in dev), bump `polling.interval_ms` back down and add "In Progress"
# back to active_states.

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
  # Plan 07: drive a real Claude Sonnet 4.5 turn. The SDK reads
  # ANTHROPIC_API_KEY from your --env-file automatically — there is
  # no `agent.api_key` field. The `linear_graphql` tool reuses the
  # same Linear client as the tracker above, so a single
  # LINEAR_API_KEY covers both reads and writes.
  #
  # To go back to the offline mock for development, switch to:
  #   kind: mock
  kind: claude
  model: claude-sonnet-4-5

  max_concurrent_agents: 1
  max_turns: 1
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
  # Plan 06 left an `after_create` hook here that posts its own
  # "Symphony picked up this issue" comment. For the Plan 07 Claude
  # smoke we want the agent itself to be the only thing posting to
  # Linear — otherwise every issue gets two comments and you can't
  # tell hook from agent. Uncomment the block below to re-enable.
  #
  # after_create: |
  #   set -euo pipefail
  #   IDENTIFIER="$(basename "$PWD")"
  #
  #   LOOKUP_QUERY='query($id: String!) { issue(id: $id) { id } }'
  #   LOOKUP_BODY=$(node -e "
  #     console.log(JSON.stringify({
  #       query: process.argv[1],
  #       variables: { id: process.argv[2] },
  #     }));
  #   " "$LOOKUP_QUERY" "$IDENTIFIER")
  #   ISSUE_UUID=$(curl -sS https://api.linear.app/graphql \
  #     -H "Authorization: $LINEAR_API_KEY" \
  #     -H "Content-Type: application/json" \
  #     -d "$LOOKUP_BODY" \
  #     | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(j.errors){console.error(JSON.stringify(j.errors));process.exit(2)};console.log(j.data.issue.id)})')
  #
  #   BODY="Symphony picked up this issue at $(date -u +%FT%TZ).
  #   Workspace: \`$PWD\`."
  #
  #   MUTATION='mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success comment { id } } }'
  #   MUTATION_BODY=$(node -e "
  #     console.log(JSON.stringify({
  #       query: process.argv[1],
  #       variables: { id: process.argv[2], body: process.argv[3] },
  #     }));
  #   " "$MUTATION" "$ISSUE_UUID" "$BODY")
  #   curl -sS https://api.linear.app/graphql \
  #     -H "Authorization: $LINEAR_API_KEY" \
  #     -H "Content-Type: application/json" \
  #     -d "$MUTATION_BODY" \
  #     > .comment-response.json
  #   echo "after_create posted comment for $IDENTIFIER (uuid=$ISSUE_UUID)" > .ws-created
---

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}

Description:
{{ issue.description | default: "(no description)" }}

Labels:
{% for l in issue.labels %}- {{ l }}
{% endfor %}

When you start work, post a brief comment on this issue summarizing
the plan, then move it to `In Progress`. 

When you finish or get stuck, post a closing comment AND move the issue to `Done` (or `Cancelled` if you're abandoning) — leaving it in `In Progress` causes the orchestrator to keep dispatching new turns every poll interval.

Use the `mcp__linear__linear_graphql` tool for all Linear writes —
see your system prompt for the operating rules.
