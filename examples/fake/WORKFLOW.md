---
tracker:
  kind: fake
  fixture_path: ./fixtures.yaml
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Canceled, Duplicate, Closed]
polling:
  interval_ms: 3000
workspace:
  root: ./.symphony-workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 1
  turn_timeout_ms: 5000
  read_timeout_ms: 1000
  stall_timeout_ms: 0
hooks:
  timeout_ms: 5000
  after_create: |
    echo "Hello from after_create — workspace=$(pwd)" > .ws-created
  before_run: |
    echo "before_run for $(basename $(pwd))" >> .ws-log
  after_run: |
    echo "after_run for $(basename $(pwd))" >> .ws-log
---

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

Description:
{{ issue.description | default: "(no description)" }}

Current state: {{ issue.state }}
Labels: {% for l in issue.labels %}{{ l }}{% unless forloop.last %}, {% endunless %}{% endfor %}

Plan your approach, then implement.
