# Plan 09 — Multi-project orchestration + per-task agent pods

- **Status:** 📝 Drafted
- **Replaces:** the original Plan 09 (Docker + polish, scope was
  too broad), the original Plan 10 (E2B cloud devbox), and the
  prior 09 draft (multi-project + agent-on-host shelling into
  containers via PATH wrappers).
- **Reshape rationale (2026-04-30):** the prior draft built the
  pod but kept the agent process on the host, with `Bash` calls
  routed through `docker exec` via PATH-wrapper shims. After
  walking through the model end-to-end, the cleaner shape is
  **agent-in-pod**: each per-issue container runs the agent
  process itself; the daemon talks to it over a thin RPC. This
  matches the **"Prefect for coding agents"** mental model — the
  daemon is the control plane, each pod is one ephemeral worker.
  It also leaves a clean seam for swapping local Docker for
  E2B / ECS / other backends later, which the PATH-wrapper
  approach actively prevented.
- **Spec sections:** §5 (single workflow file — deviated),
  §9 (workspace management — substituted), §11.2 (single
  `project_slug` — deviated). All recorded in
  `docs/product-specs/deviations.md`.
- **Layers touched:** `config/` (deployment YAML schema),
  `tracker/` (multi-instance), `workspace/` → renamed
  `execution/` (ExecutionBackend abstraction + LocalDockerBackend),
  `agent/` (entrypoint shim that runs inside the pod),
  new top-level `docker/` (base image), `examples/` (deployment
  + per-repo templates), new `docs/design-docs/0011-*` (TBD —
  drafted alongside the first stage of this plan).
- **ADRs referenced:** 0005 (harness-first), 0006 (zod at every
  boundary), 0007 (FakeTracker before real Linear — same
  approach for FakeBackend), 0009 (multi-project config),
  0010 (HTTP provisional), **0011 (TBD — agent-in-pod +
  ExecutionBackend abstraction)**.
- **Comes BEFORE:** Plan 10 (Deployable services + v1 polish).

## Goal

End-to-end production-shaped loop on a developer's laptop, with
operationally honest isolation **and a backend seam that survives
the move to managed devboxes**:

1. Operator declares N projects in a `symphony.yaml` deployment
   config. Symphony self-hosts: one of those projects is the
   Symphony repo itself.
2. A Linear issue lands in any of those projects in `Todo`.
3. The daemon picks it up, ensures a per-issue workspace under
   `<root>/<project_key>/<issue_id>/`, and calls
   `ExecutionBackend.start(...)` — which returns a running pod
   with **the agent process already inside it**. The daemon
   does NOT shell into the pod to run commands.
4. The agent (in the pod): clones the repo, reads
   `.symphony/workflow.md`, makes the requested changes, runs
   tests, commits, pushes a branch, opens (or updates) a PR with
   `gh`, posts the PR link as a Linear comment, and exits.
5. **Side effects are idempotent.** Re-running the same issue
   does NOT open a second PR, does NOT post a duplicate "starting
   work" comment. The agent finds-or-creates rather than blindly
   creating.
6. `ExecutionBackend.stop(...)` — pod dies. State that survives is
   the workspace volume (for resume across restarts) and the
   session log on disk.

After this plan, the only piece between "laptop demo" and
"production" is the deployment tier (Plan 10): wrap the daemon
and dashboard themselves in containers, add docker-compose, ship
the HTTP-split from ADR 0010.

## Outcome shape (preview)

```
symphony.yaml
   ↓ operator's deployment config (lists N projects)
   ↓
Daemon (control plane)
   ├── for each project:
   │     LinearTracker(project_slug, sharedLinearClient)
   ├── per-tick:
   │     poll each tracker → candidates → dispatch
   ├── on dispatch:
   │     ensure workspace at <root>/<project_key>/<issue_id>/
   │     resolve image: per-repo .symphony/agent.dockerfile,
   │                    or .devcontainer/Dockerfile,
   │                    or symphony/agent-base:1
   │     ExecutionBackend.start({ image, workspace, env, prompt })
   │       → returns PodHandle with attached event stream
   │     stream events into OrchestratorState (same shape as today)
   │     on terminal event: ExecutionBackend.stop(handle)
   ↓
ExecutionBackend (interface; v1 has one impl)
   ├── LocalDockerBackend       ← v1, shells to `docker`
   ├── (E2BBackend)              ← future, out of scope
   └── (EcsBackend)              ← future, out of scope
   ↓
Pod (one per issue, ephemeral)
   ┌─────────────────────────────────────────────────┐
   │ Agent process (Claude Agent SDK) — runs HERE    │
   │   tools: Bash, Read, Edit, Write, Glob, Grep,   │
   │          mcp__linear__linear_graphql            │
   │   cwd:   /workspace                             │
   │ ↓                                               │
   │ git, gh, node, pnpm, plus per-project deps     │
   │ /workspace ← bind-mounted from host's per-      │
   │              issue workspace dir                │
   │ env: GITHUB_TOKEN, ANTHROPIC_API_KEY,           │
   │      SYMPHONY_ISSUE_*, SYMPHONY_PROJECT_*       │
   │ stdout/stderr ← daemon reads via docker logs    │
   │ events       → daemon reads via attached stream │
   └─────────────────────────────────────────────────┘
```

## Why agent-in-pod, not agent-on-host

This is the structural decision that drives the rest of the plan.

- **Mental model.** "Pod = one issue's complete world" is the
  Prefect / Argo / k8s Job model. A future reader asking "where
  does the agent run?" gets one answer, not "the daemon process
  but its Bash tool calls happen elsewhere".
- **Backend portability.** An `ExecutionBackend` whose contract
  is "start a pod with the agent in it; stream events back;
  stop the pod" maps trivially to E2B (their whole product is
  this), Fargate, k8s Jobs. The PATH-wrapper approach only fits
  local Docker and would have to be undone before any other
  backend.
- **Isolation by construction.** When the agent process *is*
  inside the container, it physically cannot reach host tools.
  No PATH games, no `PreToolUse` hook to reject `/usr/local/bin/`
  paths. The container is the boundary, period.
- **State recovery.** When the daemon restarts, it can re-attach
  to a still-running pod by name. The session log lives on the
  bind-mounted workspace, so resume semantics survive a daemon
  bounce.

The cost is a thin daemon ↔ pod RPC for streaming events. We
already have `AgentEvent` as a discriminated union and the
`AsyncIterable` runner contract; the RPC just serializes those
events over a Unix domain socket per pod. ~100 lines.

## Why container-per-task (not container-per-command)

Settled in the prior draft; preserving the reasoning:

- `docker run --rm` per shell command costs 200–500ms cold-start
  per call. A typical turn makes dozens of `git` / `pnpm` / `gh`
  calls; that's 30+ seconds of pure docker overhead per turn,
  plus no warm caches.
- One container per task amortizes startup to once per dispatch.

## Why containers in this plan, not in Plan 10's deployment work

Two distinct containerizations:

- **This plan (09):** the **agent's execution environment** is a
  container. Per-issue, ephemeral. Owned by the orchestrator's
  dispatch path.
- **Plan 10:** the **daemon's deployment environment** is a
  container, alongside one for the dashboard and one for the API
  process. Per-deployment, long-lived. Owned by docker-compose.

Both are real and both are needed. They don't depend on each
other.

## Out of scope

- **Cloud sandbox backends (E2B / Firecracker / Fargate).** The
  `ExecutionBackend` interface is designed to accept them later.
  Implementing them is not this plan's work.
- **Auto-build of per-repo agent images.** First dispatch errors
  with an actionable message ("run `pnpm docker:build:<key>`"),
  the operator builds manually, retry succeeds. Auto-build is
  Plan 11+ territory (cache invalidation by Dockerfile/lockfile
  hash, build queue, etc.).
- **Network egress restrictions on the agent pod.** The pod needs
  `git push`, `gh`, npm registry — full network access for now.
  Per-pod network policies are a later concern.
- **Per-tool permission prompts (`PreToolUse` hooks).** We trust
  the agent within its `allowed_tools` list. Real hooks are
  Plan 14 territory.
- **Resource caps (CPU/mem/disk) on the agent pod.** Add once we
  have a sense of normal workload sizes.
- **Multi-arch images.** Build for the host's arch only.
- **Conformance test for per-repo `workflow.md`.** The schema is
  documented; a CI step that verifies a target repo's file parses
  is a Plan 11+ exercise.
- **Symphony repo's own `.symphony/workflow.md` polish.** Created
  as part of this plan as the dogfood demo, but the workflow can
  evolve afterwards without retroactively counting against this
  plan.

## Steps

### Stage 09a — ADR 0011 + ExecutionBackend interface

The architectural decisions in this plan are big enough that they
deserve their own ADR. Draft it before writing implementation
code.

1. **Draft ADR 0011** at
   `docs/design-docs/0011-agent-in-pod-and-execution-backend.md`:
   - Decision: agent process runs INSIDE the per-task pod;
     daemon talks to it over a per-pod Unix domain socket.
   - Decision: introduce `ExecutionBackend` interface; v1 ships
     one impl (`LocalDockerBackend`).
   - Alternatives considered: agent-on-host with PATH wrappers
     (prior 09 draft), agent-on-host with `docker exec` per
     command, E2B from day one.
   - Consequences: daemon ↔ pod RPC is now load-bearing;
     backend swap is a Plan 11+ refactor that preserves the
     interface; the workspace bind-mount is the durable state
     boundary.

2. **`ExecutionBackend` interface** at
   `packages/daemon/src/execution/backend.ts`:
   ```ts
   interface ExecutionBackend {
     // Pre-flight image resolution + build check. Errors here
     // are surfaced to the orchestrator and recorded against the
     // issue (not silently retried).
     ensureImage(spec: ImageSpec): Promise<ImageRef>;

     // Start a pod with the agent already running inside it.
     // Returns a handle the daemon uses to stream events and
     // stop the pod. MUST be idempotent on (issueId, projectKey)
     // — if a pod already exists for that key, attach to it.
     start(input: PodStartInput): Promise<PodHandle>;

     // Stop and clean up. Idempotent. Safe to call on a pod
     // that's already gone.
     stop(handle: PodHandle): Promise<void>;
   }

   interface PodHandle {
     readonly podId: string;       // backend-specific
     readonly events: AsyncIterable<AgentEvent>;
     readonly logsTail: () => Promise<string>;  // for diagnostics
   }
   ```
   - Tests: a `FakeBackend` implementation (the same pattern as
     `FakeTracker` from ADR 0007) — used in orchestrator tests
     so we don't need real docker for unit tests.

### Stage 09b — Multi-project config split

3. **Deployment YAML schema** in
   `packages/daemon/src/config/deployment.ts`:
   - zod schema:
     ```yaml
     polling: { interval_ms }
     workspace: { root }
     agent: { kind, model, max_concurrent_agents, max_budget_usd, ... }
     execution:
       backend: local-docker        # only impl in v1
       base_image: symphony/agent-base:1
     hooks: { timeout_ms, after_create?, before_remove? }
     projects:
       - linear: { project_slug }
         repo:
           url
           default_branch?
           agent_image?              # explicit override; skips resolution
           workflow_path?            # default: .symphony/workflow.md
           branch_prefix?            # default: symphony/
     ```
   - Path resolution from `SYMPHONY_CONFIG` env (default
     `./symphony.yaml`).
   - Tests: schema validation, missing-fields error messages,
     env var resolution.

4. **Single-project compatibility mode**: when invoked with
   `pnpm symphony path/to/WORKFLOW.md` (today's pattern), the
   loader synthesizes a one-project deployment config in memory.
   No existing user breaks. Composition root chooses path based
   on argv (positional path → legacy mode; no positional → look
   for `symphony.yaml`).

5. **Per-repo workflow schema** in
   `packages/daemon/src/config/repo-workflow.ts`:
   - Existing `ServiceConfigSchema` minus operator-deployment
     fields (no `polling`, no `workspace`, no `tracker.api_key`).
     What remains is `agent` (per-repo overrides), `hooks`, and
     the prompt template body.
   - Loaded from the cloned repo's `<workflow_path>` after the
     clone hook runs.
   - Falls back to a built-in conservative default if absent
     (the default does ONLY safe things: read the issue, post a
     "no workflow.md found" comment, exit).

6. **Documentation**:
   - `examples/deployment/symphony.yaml` template.
   - `examples/repo-workflow/.symphony/workflow.md` template.
   - `examples/repo-workflow/.symphony/agent.dockerfile` template.
   - All linked from README.

### Stage 09c — Multi-project orchestrator

7. **`Issue.projectKey` field** in `packages/types/`:
   - The orchestrator's `Issue` gains `projectKey: string` (the
     `linear.project_slug` of the originating project).
   - All `Map<IssueId, ...>` collections keep their structure
     (issue IDs are still globally unique within a Linear
     workspace). The `projectKey` is metadata.

8. **`LinearTracker` per project**: today's single-construction
   pattern becomes one tracker per project, all sharing the same
   `LinearClient`. The orchestrator's tick loop iterates
   trackers, accumulating candidates with `projectKey` stamped on
   each.

9. **Project-namespaced workspaces**: workspace path becomes
   `<workspace.root>/<project_key>/<issue_id>/`. Pod name becomes
   `symphony-<sanitized_project>-<sanitized_issue>`.

10. **Snapshot + dashboard**: `OrchestratorState` snapshot gains
    a per-project breakdown so the dashboard can show per-project
    counters. Wire shape (`StateSnapshotWire`) gains a
    `projects: ProjectSnapshotWire[]` field. Dashboard panels
    group by project.

### Stage 09d — Agent-in-pod runtime

11. **Agent entrypoint shim** at
    `packages/agent-runtime/src/entrypoint.ts` (new package):
    - Reads its task spec from `/etc/symphony/task.json`
      (mounted by the backend at pod start). Includes prompt,
      issue metadata, allowed tools, model, budget caps,
      session id (for resume).
    - Constructs `ClaudeAgent` (today's class, almost unchanged)
      and runs `query()`.
    - Streams `AgentEvent`s as JSON lines to a Unix domain
      socket at `/var/run/symphony/events.sock` (mounted by the
      backend; the daemon end of the socket is what reads them).
    - Writes session.json updates to `/workspace/.symphony/`
      (bind-mounted to host).
    - Exits 0 on terminal event, non-zero on crash.

12. **`packages/agent-runtime/Dockerfile.base`** — the image the
    pod actually runs:
    - `node:20-bookworm-slim` base.
    - Installs: git, gh, pnpm (corepack), tini, jq, ca-certs.
    - Bundles the agent-runtime entrypoint at known path
      (`/opt/symphony/agent-runtime/dist/entrypoint.js`).
    - Bundles the Claude Agent SDK + production deps.
    - Non-root `agent` user (uid 1000).
    - `ENTRYPOINT ["/usr/bin/tini", "--", "node",
      "/opt/symphony/agent-runtime/dist/entrypoint.js"]`.
    - Tagged `symphony/agent-base:1`. The version tag bumps when
      the contract (entrypoint, mounted-paths, env vars) changes.

13. **`LocalDockerBackend`** at
    `packages/daemon/src/execution/local-docker.ts`:
    - `ensureImage`: resolves to per-repo image if the project
      config sets `agent_image` AND the tag exists locally; else
      checks for `.symphony/agent.dockerfile` or
      `.devcontainer/Dockerfile` after clone (image build is
      separate — see step 14); else uses `symphony/agent-base`.
    - `start`: shells `docker run --rm -d --name <pod-name>
      -v <workspace>:/workspace -v <events-sock>:/var/run/symphony/events.sock
      -e ...env... -v <task-json>:/etc/symphony/task.json:ro
      <image>`. Returns handle wrapping the docker container id +
      AsyncIterable that reads the events socket.
    - `stop`: `docker stop -t 5 <pod-name>; docker rm -f
      <pod-name>`. Idempotent.
    - Uses `docker` CLI (no SDK dependency). Tests mock the
      `docker` runner the same way the existing
      `WorkspaceContainer` tests do.

14. **Image resolution order** (documented contract):
    1. Project config sets explicit `agent_image: <tag>` →
       use it. Error if the tag is missing locally.
    2. Workspace contains `.symphony/agent.dockerfile` →
       expected tag is `symphony-agent/<project_key>:latest`.
       Built by `pnpm docker:build:<project_key>`. Error with
       actionable message if missing.
    3. Workspace contains `.devcontainer/Dockerfile` (and not
       (2)) → same expected tag, built from the devcontainer
       file. Free reuse of repos that already have one.
    4. Otherwise → `<execution.base_image>` from deployment
       config (default `symphony/agent-base:1`).

### Stage 09e — Idempotent side effects

This is the delta the prior plan didn't address. Without it, every
retry double-comments and the pod-restart story is broken.

15. **Per-issue branch convention** (baked into the standard
    workflow template):
    - Branch name: `<branch_prefix><issue_identifier>` (e.g.
      `symphony/EDU-123`).
    - The clone-step hook runs:
      ```bash
      git fetch origin
      if git ls-remote --exit-code origin "$SYMPHONY_BRANCH"; then
        git checkout "$SYMPHONY_BRANCH"
        git pull --rebase origin "$SYMPHONY_BRANCH"
      else
        git checkout -b "$SYMPHONY_BRANCH" "origin/$SYMPHONY_DEFAULT_BRANCH"
      fi
      ```
    - Re-running the same issue picks up where the last attempt
      left off rather than starting from scratch on `main`.

16. **PR upsert** (in the prompt template + a small wrapper
    script):
    - The agent calls `gh pr view --json url,number "$SYMPHONY_BRANCH"
      || gh pr create --base "$SYMPHONY_DEFAULT_BRANCH" --head "$SYMPHONY_BRANCH" ...`.
    - Standard `before_run` hook installs a `symphony-pr-ensure`
      shim wrapping this so the agent's prompt can just say
      "ensure the PR exists" without spelling out the bash.

17. **Comment dedup via marker**:
    - The agent's "starting work" and "completed" comments
      include a stable HTML-comment marker:
      `<!-- symphony:starting-work attempt=1 -->`.
    - Standard prompt template instructs the agent: "before
      posting a `starting-work` comment, list comments and
      check for that marker; if present, skip the post and
      reference it instead."
    - Not bulletproof (the agent might forget); good enough for
      v1. Real fix is a `PreToolUse` hook in Plan 14.

18. **Tracker write idempotency** at the daemon level:
    - When the daemon transitions an issue's state, it first
      checks current state via the LinearClient cache and
      no-ops if already correct. Avoids the "transition to In
      Progress" double-fire that surfaced during the Plan 07
      smoke (decision log entry 2026-04-29).

### Stage 09f — End-to-end real PR demo

19. **Symphony's own `.symphony/`** files:
    - `.symphony/workflow.md` — instructs agents working on
      Symphony to follow project conventions (TS strict,
      `pnpm test`, layer rules).
    - `.symphony/agent.dockerfile` — extends `symphony/agent-base:1`
      with whatever Symphony itself needs (mostly nothing for
      v1; the file exists as an example for other repos).

20. **Live smoke against `EDU-X`**:
    - One Linear issue: "Bump prettier patch, run `pnpm
      lint:fix`, open PR."
    - Watch the dashboard.
    - Verify (and capture in the decision log):
      - PR opens on GitHub against the right branch.
      - Linear comment lands with the PR URL.
      - Linear issue transitions per the workflow.
      - **Restart-mid-run**: kill the daemon mid-turn; restart.
        Daemon re-attaches to the still-running pod, streams
        remaining events, terminal event lands.
      - **Idempotency**: cancel + re-trigger the same issue.
        Result: same PR URL pushed-to, no duplicate comments.
      - **Host has no `pnpm`**: `which pnpm` empty on host (or
        returns the host's, doesn't matter — the agent's pnpm
        is the container's, by construction). Verify via
        recorded `tool_call` events that no host paths leaked.

### Stage 09g — Tests + docs

21. **Tests**:
    - Deployment YAML schema (validation, error messages, env
      resolution).
    - Per-repo workflow loader (parsing, fallback when missing).
    - Multi-project FakeTracker fixtures (two projects, issues
      across both, ordering).
    - `FakeBackend` impl + orchestrator tests using it (no
      docker dependency).
    - `LocalDockerBackend` with mocked `docker` runner.
    - Image resolution order (all four cases).
    - Idempotency: re-running a completed issue is a no-op;
      retrying a failed run reuses the branch.
    - Daemon-restart-mid-run reattach: spin up a long-running
      `FakeBackend` pod, kill+restart the orchestrator,
      assert events resume.

22. **Documentation**:
    - `README.md` — multi-project quickstart.
    - `examples/deployment/README.md` — operator setup.
    - `examples/repo-workflow/README.md` — repo-team setup
      (workflow.md + agent.dockerfile + devcontainer fallback).
    - `ARCHITECTURE.md` — update layer map for ExecutionBackend
      seam and agent-in-pod.
    - `SECURITY.md` — note the GITHUB_TOKEN propagation path
      and the docker-socket trade-off (deferred to Plan 10's
      docs since it's the daemon-as-container that holds the
      socket).
    - `docs/product-specs/deviations.md` — entries for §5,
      §11.2, §9.3 marked "Implemented".

## Definition of done

- ADR 0011 written and Accepted.
- `symphony.yaml` with two projects (Symphony itself + a second
  test repo) drives the daemon end-to-end.
- A real Linear issue in the second project triggers a real PR
  on its repo, with a Linear comment linking to it.
- Re-triggering the same issue produces no duplicate PR and no
  duplicate "starting work" comment; instead, a new commit
  pushed to the existing branch.
- Killing the daemon mid-turn and restarting reattaches to the
  running pod and finishes the turn.
- Removing the host's `git`, `pnpm`, or `gh` does NOT break the
  demo (the pod is the source of truth for those tools).
- Image resolution honors all four sources (explicit tag,
  `.symphony/agent.dockerfile`, `.devcontainer/Dockerfile`,
  base image fallback) — verified by tests + at least one demo
  per source.
- Dashboard's "Running" panel groups by project.
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean.
- ADR 0009 updated to reflect any plan-time deviations (or
  recorded in `deviations.md`).
- Symphony's own `.symphony/workflow.md` exists and is at least
  exercised once via a self-hosted dispatch on a small issue.

## Open questions

- **Per-project budgets — operator-side cap, repo-side override,
  or both?** Tentative: operator-side hard cap (deployment YAML),
  repo-side advisory floor (workflow.md). Effective cap =
  `min(operator_cap, repo_cap)`. Resolve early.
- **Daemon ↔ pod RPC: per-pod Unix socket vs single shared
  socket with pod-id framing?** Tentative: per-pod socket,
  bind-mounted at a known path. Simpler — no multiplexing.
- **What happens when `gh pr create` fails (rate limit, network)?**
  The agent gets the error in `tool_result`; the workflow.md
  prompt should instruct it to comment + retry on next turn.
  Daemon doesn't bake retry semantics for this — it's the
  agent's call.
- **`branch_prefix` default — `symphony/` or `<project_key>/`?**
  Tentative: `symphony/`. Rationale: makes branches grep-able
  across repos; project context is in the issue identifier.
- **Image build trigger — manual `pnpm docker:build:<key>` or
  daemon auto-builds on first dispatch?** Manual for v1.
  Auto-build needs cache invalidation by Dockerfile + lockfile
  hash, which is its own design problem (Plan 11+).
- **Should the agent-runtime package live in this repo or a
  separate one?** In this repo for v1 (versioning is `npm
  version` + image tag bump). Separate repo only if/when third
  parties want to write alternate runtimes.

## Decision log

(empty — populated as the plan executes)
