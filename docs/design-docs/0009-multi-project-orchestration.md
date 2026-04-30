# 0009 — Multi-project orchestration

- **Status:** Accepted
- **Date:** 2026-04-29

## Context

The Symphony spec (vendored in `docs/product-specs/symphony-spec.md`)
is shaped around a single project. SPEC §5.3.1 defines
`tracker.project_slug` as a single string, and the entire
`WORKFLOW.md` describes one tracker, one prompt template, one set of
hooks. Plans 1–8 implemented exactly that: one daemon process,
watching one Linear project, dispatching agents into per-issue
workspaces under a single root.

That works for a hobby project where the daemon and the target repo
are the same. It does not work once you want:

1. A single Symphony deployment watching N Linear projects (Symphony
   itself, plus 1..M other repos).
2. Each project pointing at a different git repository, with
   different bootstrap requirements, possibly different Docker
   images, and a workflow definition the **target repo's team owns**
   (not the operator running Symphony).
3. The agent to clone the right repo for the right issue, follow
   that repo's conventions (lint, tests, PR template, branch naming),
   and write back to Linear with a PR link — without Symphony's
   operator knowing anything about the repo's specifics.

The single-`WORKFLOW.md` model conflates four orthogonal concerns:

- **Operator-owned deployment config** (which Linear projects to watch,
  where workspaces live, daemon-wide concurrency caps, agent budget
  limits).
- **Operator-owned project bindings** (Linear project → git repo URL).
- **Repo-team-owned workflow** (prompt template, hooks, allowed
  tools, PR conventions for THIS repo).
- **Ephemeral per-issue state** (workspace, container, session,
  retry queue entry).

Putting all four in one YAML file means edits to the workflow
require touching the operator's deployment, and edits to the
deployment require touching every workflow. This is the same
anti-pattern as committing CI config into your shell's
`.bashrc` — different ownership, different change cadence,
different review path.

## Decision

Symphony adopts a **four-layer configuration model** with explicit
ownership boundaries. The single `WORKFLOW.md` file is replaced by:

### Layer 1 — Operator deployment config

File: `symphony.yaml` at the daemon's run dir (or wherever
`SYMPHONY_CONFIG` points). Owned by **whoever runs Symphony**.

Content shape:

```yaml
polling:
  interval_ms: 30000
workspace:
  root: /var/lib/symphony/workspaces
agent:
  kind: claude
  model: claude-haiku-4-5
  max_concurrent_agents: 3
  max_budget_usd: 5.00
projects:
  - linear:
      project_slug: c58e6fc4ca75
    repo:
      url: https://github.com/eduardobrito/my-own-symphony.git
      default_branch: main
      # Optional: per-project Docker image override. Defaults to
      # the generic `symphony/agent:dev` if absent.
      agent_image: symphony/agent:my-own-symphony
      # Optional: where the per-repo workflow lives inside the
      # cloned repo. Defaults to `.symphony/workflow.md`.
      workflow_path: .symphony/workflow.md
  - linear:
      project_slug: abc123def456
    repo:
      url: https://github.com/some-org/marketing-site.git
      default_branch: production
```

This is the daemon's startup config. Adding a new project = one row.

### Layer 2 — Per-project bindings

A single project entry inside the deployment config. Conceptually
distinct from Layer 1's daemon-wide settings — split out here
because it changes more often (project comes online / goes offline)
and may be edited by different operators in larger deployments.

For our scale (one developer, today), Layers 1 and 2 share a file.
We treat them as logically separate so the future split is just
moving fields out, not reshaping ownership.

### Layer 3 — Per-repo workflow

File: `<target-repo>/.symphony/workflow.md`. Lives **inside the
target repo**, version-controlled with the code. Owned by **the
repo's team**.

Content shape mirrors today's WORKFLOW.md but **without** any
operator-deployment fields (no `polling`, no `workspace.root`, no
`server`, no `tracker.api_key`):

```yaml
---
agent:
  # The repo's team picks the safe-default tool surface for THIS
  # repo. Tests-only? Allow Read+Edit+Write. Migrations possible?
  # Restrict the bash tool list further.
  allowed_tools: [Bash, Read, Edit, Write, Glob, Grep, mcp__linear__linear_graphql]
hooks:
  before_run: |
    pnpm install
    pnpm build
  after_run: |
    # Optional cleanup; failures are ignored per spec §9.4.
---
You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.
…
```

When the daemon dispatches an agent, the per-repo workflow is read
**after the clone** (the clone is the act that makes Layer 3
visible). If absent, Symphony falls back to a built-in conservative
default workflow.

### Layer 4 — Ephemeral per-issue state

Per-issue workspace dir, per-issue Docker container, per-issue
session.json, per-issue retry queue entry. Lives under
`<workspace.root>/<project_key>/<issue_id>/`. Owned by **nobody**;
disposable; cleaned up when the issue goes terminal.

The new project namespace in the path (`<project_key>/`) is the
key change — today's workspace path is flat
`<workspace.root>/<issue_id>`, which collides if two projects ever
share an identifier prefix.

## Alternatives considered

**(a) Issue-level metadata (Linear labels or custom fields).**
Each Linear issue carries `repo:my-own-symphony` as a label, agent
reads it. Pros: zero deployment-side config to add a project. Cons:
fragile (one mistyped label routes the agent to a wrong repo),
puts the operator's secrets close to user-modifiable data, and
requires a label-or-field convention humans must remember. Rejected.

**(b) Project-level metadata in Linear's project description.** A
YAML block in each Linear project's description with
`repo: <url>`. Pros: less fragile than per-issue labels.
Cons: same "operator config in user-editable place" problem; Linear
project descriptions are not validated against any schema; debug
loop is awful. Rejected.

**(c) Convention-based mapping** (Linear project name → GitHub repo
under a fixed org). Brittle the moment names diverge or you have
two orgs. Rejected.

**(d) Stay single-project and run N daemons.** Pros: zero design
change. Cons: N pollers hammering Linear from the same machine, N
agent budgets to track, N dashboards. Operationally awful at any
N > 2. Rejected.

**(e) Workflow-as-code in the OPERATOR's repo (not target repo).**
Operator maintains a directory of workflow files indexed by Linear
project. Pros: keeps everything in one place. Cons: defeats the
"the team that owns the repo owns its agent's behavior" principle.
The point of per-repo workflows is that PRs to a repo can iterate
its agent's behavior without touching Symphony. Rejected.

## Consequences

**Easier:**

- Adding a new project to Symphony = one row in deployment YAML +
  one `.symphony/workflow.md` PR to the target repo. No daemon
  restart needed (config reload picks up the new project on the
  next poll).
- Per-team ownership of agent behavior: the team that owns
  `marketing-site` owns `marketing-site/.symphony/workflow.md`.
  PR review of agent prompt changes is normal repo PR review.
- Per-project Docker images become natural — a Python repo gets
  `agent_image: symphony/agent:python`, a JS repo gets the
  default. Defined alongside the rest of the project binding.
- Symphony self-hosts: the Symphony repo itself ships a
  `.symphony/workflow.md` and is one row in the deployment YAML.

**Harder:**

- The orchestrator's dispatch path is now project-aware: it
  iterates projects, polls each, dispatches per-project. The
  existing single-project assumption is baked into:
  `LinearTracker` (one slug at construction), `Orchestrator`
  (`config.tracker.*` shape), `WorkspaceManager`
  (one root, no project subdir), `index.ts` (one workflow file
  read at startup).
- Workflow loading happens **after** clone, not at startup. The
  agent dispatch is now: poll → discover candidate → ensure
  workspace + clone → read repo's workflow → dispatch agent.
  Ordering matters; failures at each stage need clean handling.
- Per-project budget caps and concurrency caps add a second
  dimension to the "how many agents can run" question.

**Constrained:**

- We are now **explicitly off-spec** for SPEC §5 (single
  `WORKFLOW.md`) and §11.2 (single `tracker.project_slug`). This
  is a substantive deviation, not a substitution. Recorded in
  `docs/product-specs/deviations.md`.
- The per-repo workflow contract is a new public surface. Repos
  with `.symphony/workflow.md` become tied to whatever schema we
  expose; breaking changes to that schema are breaking changes
  for every onboarded repo.

## Implementation notes

- Existing `WORKFLOW.md` keeps working in **single-project
  compatibility mode**: if `SYMPHONY_CONFIG` is unset and the daemon
  is invoked with a single workflow path argument (today's pattern),
  it constructs an implicit deployment config with one project. No
  existing workflow file breaks.
- `LinearTracker` extends to multi-project naturally: today's
  single instance becomes a per-project instance, all sharing one
  `LinearClient`.
- The `Issue` domain object gains a `projectKey: string` field. The
  orchestrator's dispatch logic + state machine (`running`,
  `claimed`, `retryAttempts` maps) become project-aware via that
  field.
- `Orchestrator.snapshot()` exposes per-project totals for the
  dashboard.
- The harness rules (ADR 0005) say: **make the deviation
  mechanically obvious**. The schema for the new deployment YAML is
  in zod; the per-repo workflow.md schema is the same one we use
  today minus the operator fields.

## Schedule

This decision is implemented in
[Plan 09](../exec-plans/completed/09-multi-project-and-agent-runtime.md).
The plan includes the schema, the orchestrator refactor, the
project-namespaced workspace path, and a self-hosting demo against
the Symphony repo's own Linear project.

The deployment-side packaging (Dockerfiles, docker-compose) is
[Plan 13](../exec-plans/active/13-deployable-services-and-v1-polish.md).
