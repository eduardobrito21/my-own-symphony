---
# Symphony WORKFLOW for testing the real Linear adapter (Plan 06).
# See examples/linear/README.md for setup notes.

tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: c58e6fc4ca75
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Canceled, Duplicate, Closed]

polling:
  interval_ms: 5000

workspace:
  # OUTSIDE the repo so we don't accidentally commit per-issue dirs.
  root: /tmp/symphony-linear-test-workspaces

agent:
  max_concurrent_agents: 2
  max_turns: 1
  turn_timeout_ms: 5000
  read_timeout_ms: 1000
  stall_timeout_ms: 0
  max_retry_backoff_ms: 60000

hooks:
  # Bumped from 5s because the after_create hook below makes two
  # round-trips to Linear (lookup + commentCreate).
  timeout_ms: 10000
  after_create: |
    # Post a comment to the Linear issue when its workspace is first
    # created. Demonstrates that the daemon (or anything launched by
    # it — hooks, agents) can write back to Linear, not just read.
    #
    # Hook environment:
    #   - cwd is the per-issue workspace, named after the identifier
    #     (e.g., /tmp/.../EDU-5), so `basename "$PWD"` gives `EDU-5`.
    #   - $LINEAR_API_KEY is inherited from the daemon's --env-file.
    #   - Python's not assumed; we use `node -e` for JSON parsing
    #     since the daemon's own Node is on PATH.
    #
    # Two GraphQL calls because Linear's commentCreate needs the
    # issue UUID, not the human identifier:
    #   1) issue(id: "EDU-5") -> { id: "<uuid>" }
    #   2) commentCreate(input: { issueId: "<uuid>", body: ... })
    set -euo pipefail
    IDENTIFIER="$(basename "$PWD")"

    LOOKUP_QUERY='query($id: String!) { issue(id: $id) { id } }'
    LOOKUP_BODY=$(node -e "
      console.log(JSON.stringify({
        query: process.argv[1],
        variables: { id: process.argv[2] },
      }));
    " "$LOOKUP_QUERY" "$IDENTIFIER")
    ISSUE_UUID=$(curl -sS https://api.linear.app/graphql \
      -H "Authorization: $LINEAR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$LOOKUP_BODY" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(j.errors){console.error(JSON.stringify(j.errors));process.exit(2)};console.log(j.data.issue.id)})')

    BODY="Symphony picked up this issue at $(date -u +%FT%TZ).
    Workspace: \`$PWD\`.
    (Plan 06 smoke test — posted from the after_create hook.)"

    MUTATION='mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success comment { id } } }'
    MUTATION_BODY=$(node -e "
      console.log(JSON.stringify({
        query: process.argv[1],
        variables: { id: process.argv[2], body: process.argv[3] },
      }));
    " "$MUTATION" "$ISSUE_UUID" "$BODY")
    curl -sS https://api.linear.app/graphql \
      -H "Authorization: $LINEAR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$MUTATION_BODY" \
      > .comment-response.json
    echo "after_create posted comment for $IDENTIFIER (uuid=$ISSUE_UUID)" > .ws-created
---

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}

Description:
{{ issue.description | default: "(no description)" }}

Labels:
{% for l in issue.labels %}- {{ l }}
{% endfor %}

(This is a Plan 06 smoke test — the MockAgent is just emitting fake
events. Real Claude arrives in Plan 07.)
