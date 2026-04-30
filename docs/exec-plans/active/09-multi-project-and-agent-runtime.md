# Plan 09 — Multi-project orchestration + ExecutionBackend foundation

- **Status:** 📝 Drafted (Stage 09a complete)
- **Replaces:** the original Plan 09 (Docker + polish, scope was
  too broad), the original Plan 10 (E2B cloud devbox), and the
  prior 09 draft (multi-project + agent-on-host shelling into
  containers via PATH wrappers).
- **Reshape rationale (2026-04-30):** the original "Plan 09 does
  everything" scope was too big to ship as one unit. Split into
  four plans (this one + 10 + 11 + 12) for clean test gates
  between. This plan ships the **foundation**: multi-project
  config + multi-project orchestrator + the ExecutionBackend
  interface with FakeBackend. The production `LocalDockerBackend`
  is Plan 10; idempotent side effects are Plan 11; live PR demo
  is Plan 12. Deployment containerization is Plan 13 (was Plan
  10). See decision log below for the full split rationale.
- **Spec sections:** §5 (single workflow file — deviated),
  §11.2 (single `project_slug` — deviated). Recorded in
  `docs/product-specs/deviations.md`.
- **Layers touched:** `config/` (deployment YAML schema +
  per-repo workflow schema), `tracker/` (multi-instance), new
  `execution/` layer (interface + FakeBackend), `types/`
  (`Issue.projectKey` field), `orchestrator/` (per-project
  iteration + project-namespaced workspaces + per-project
  snapshot), and ADR
  `docs/design-docs/0011-agent-in-pod-and-execution-backend.md`.
- **ADRs referenced:** 0005 (harness-first), 0006 (zod at every
  boundary), 0007 (FakeTracker before real Linear — same
  approach for FakeBackend), **0009 (multi-project config)**,
  **0011 (agent-in-pod and ExecutionBackend abstraction)**.
- **Comes BEFORE:** Plan 10 (Agent-in-pod runtime +
  LocalDockerBackend), then Plan 11 (idempotent side effects),
  then Plan 12 (end-to-end PR demo), then Plan 13 (deployable
  services + v1 polish).

## Goal

The orchestrator runs end-to-end across N projects, fully
exercised in tests, **without ever building a Docker image**:

1. Operator declares N projects in a `symphony.yaml` deployment
   config.
2. The daemon constructs one `LinearTracker` per project, all
   sharing one `LinearClient`.
3. Each tick: the daemon polls every project's tracker,
   accumulates candidates with `projectKey` stamped on each,
   dispatches eligible ones.
4. Dispatch goes through the new `ExecutionBackend` interface
   (introduced by ADR 0011). v1 of this plan ships only
   `FakeBackend` for tests; the production `LocalDockerBackend`
   is Plan 10.
5. Workspaces are project-namespaced:
   `<workspace.root>/<project_key>/<issue_id>/`. Pod names
   (used by future backends) follow `symphony-<project>-<issue>`.
6. The dashboard's snapshot includes a per-project breakdown.

What's deliberately NOT in this plan (deferred):

- Building or running real Docker pods → Plan 10.
- Idempotent re-dispatch (per-issue branch, PR upsert, comment
  dedup) → Plan 11.
- Live PR demo against real Linear + real GitHub → Plan 12.
- Containerizing the daemon itself + docker-compose → Plan 13.

The minimum demo for this plan: orchestrator with a
multi-project FakeTracker fixture (two projects) dispatches
across both, snapshot shows per-project breakdown, all 341+
existing tests still pass plus ~30 new tests for the foundation.

## Outcome shape (preview)

```
symphony.yaml
   ↓ operator's deployment config (lists N projects)
   ↓
Daemon (control plane — dispatch decisions only)
   ├── for each project:
   │     LinearTracker(project_slug, sharedLinearClient)
   ├── per-tick:
   │     poll each tracker → candidates → dispatch
   ├── on dispatch:
   │     ensure workspace at <root>/<project_key>/<issue_id>/
   │     ExecutionBackend.start({ image, workspace, env, envelope })
   │       envelope = { issueId, projectKey, tracker, repo,
   │                    operatorCaps, attempt, resumeSessionId }
   │       → returns PodHandle with attached event stream
   │     stream events into OrchestratorState (same shape as today)
   │     on terminal event: ExecutionBackend.stop(handle)
   ↓
ExecutionBackend (interface; impls below)
   ├── FakeBackend          ← v1, in-memory (this plan)
   ├── LocalDockerBackend   ← Plan 10
   ├── (E2BBackend)          ← future, out of scope
   └── (EcsBackend)          ← future, out of scope
```

The pod-side runtime details are out of scope for this plan and
covered by ADR 0011 + Plan 10.

## Out of scope

- **Anything pod-runtime related.** The agent-runtime entrypoint,
  the base image, the LocalDockerBackend impl, the per-pod
  socket protocol — all Plan 10.
- **Side-effect idempotency.** Per-issue branch reuse, PR upsert,
  comment dedup, daemon-side no-op transitions — all Plan 11.
- **Live PR demo.** Plan 12.
- **Daemon containerization, HTTP-server split, docker-compose.**
  Plan 13.
- **Cloud backends (E2B / Fargate / k8s Jobs).** The
  `ExecutionBackend` interface accepts them later; implementing
  them is not this plan's work.
- **Conformance test for per-repo `workflow.md`.** The schema
  ships in this plan; a CI step that verifies a target repo's
  file parses is a later exercise.

## Steps

### Stage 09a — ADR 0011 + ExecutionBackend interface ✅

The architectural decisions in this plan are big enough that they
deserve their own ADR. Drafted before writing implementation
code.

1. **Draft ADR 0011** at
   `docs/design-docs/0011-agent-in-pod-and-execution-backend.md`:
   - Decision A: agent process runs INSIDE the per-task pod
     (covered in Plan 10).
   - Decision B: introduce `ExecutionBackend` interface; v1 of
     this plan ships `FakeBackend` only.
   - Pod re-fetches issue from Linear and renders prompt itself
     (the daemon never opens the cloned repo).
   - Linear state-machine becomes the dispatch handshake.

2. **`ExecutionBackend` interface** at
   `packages/daemon/src/execution/backend.ts`:

   ```ts
   interface ExecutionBackend {
     ensureImage(spec: ImageSpec): Promise<ExecutionResult<ImageRef>>;
     start(input: PodStartInput): Promise<ExecutionResult<PodHandle>>;
     stop(handle: PodHandle): Promise<ExecutionResult<void>>;
   }

   interface PodHandle {
     readonly podId: string;
     readonly events: AsyncIterable<AgentEvent>;
     readonly logsTail: () => Promise<string>;
   }
   ```

   Plus the `DispatchEnvelope` shape (issue id, project key,
   tracker coordinates, repo coordinates, operator-side caps,
   attempt + resume context).

3. **`FakeBackend`** at `packages/daemon/src/execution/fake.ts`,
   following the `FakeTracker` (ADR 0007) pattern. Ships in
   production code so the orchestrator's composition root may
   pick it via `execution.backend: fake` for dry runs.

### Stage 09b — Multi-project config split

4. **Deployment YAML schema** in
   `packages/daemon/src/config/deployment.ts`:
   - zod schema:
     ```yaml
     polling: { interval_ms }
     workspace: { root }
     agent: { kind, model, max_concurrent_agents, max_budget_usd, ... }
     execution:
       backend: local-docker  # or 'fake' for dry runs
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

5. **Single-project compatibility mode**: when invoked with
   `pnpm symphony path/to/WORKFLOW.md` (today's pattern), the
   loader synthesizes a one-project deployment config in memory.
   No existing user breaks. Composition root chooses path based
   on argv (positional path → legacy mode; no positional → look
   for `symphony.yaml`).

6. **Per-repo workflow schema** in
   `packages/daemon/src/config/repo-workflow.ts`:
   - Existing `ServiceConfigSchema` minus operator-deployment
     fields (no `polling`, no `workspace`, no `tracker.api_key`).
     What remains is `agent` (per-repo overrides), `hooks`, and
     the prompt template body.
   - Loaded **by the agent-runtime in the pod** (Plan 10), not
     by the daemon. This plan ships only the schema + a
     standalone parser; Plan 10 wires it into the entrypoint.
   - Falls back to a built-in conservative default if absent.

7. **Documentation**:
   - `examples/deployment/symphony.yaml` template.
   - `examples/repo-workflow/.symphony/workflow.md` template.
   - Both linked from README.

### Stage 09c — Multi-project orchestrator

8. **`Issue.projectKey` field** in `packages/types/`:
   - The orchestrator's `Issue` gains `projectKey: string` (the
     `linear.project_slug` of the originating project).
   - All `Map<IssueId, ...>` collections keep their structure
     (issue IDs are still globally unique within a Linear
     workspace). The `projectKey` is metadata.

9. **`LinearTracker` per project**: today's single-construction
   pattern becomes one tracker per project, all sharing the same
   `LinearClient`. The orchestrator's tick loop iterates
   trackers, accumulating candidates with `projectKey` stamped
   on each.

10. **Project-namespaced workspaces**: workspace path becomes
    `<workspace.root>/<project_key>/<issue_id>/`. Pod name
    (used by future backends) becomes
    `symphony-<sanitized_project>-<sanitized_issue>` (the
    `podNameFor` helper in `execution/backend.ts` already
    returns this).

11. **Snapshot + dashboard**: `OrchestratorState` snapshot gains
    a per-project breakdown so the dashboard can show per-project
    counters. Wire shape (`StateSnapshotWire`) gains a
    `projects: ProjectSnapshotWire[]` field. Dashboard panels
    group by project.

### Stage 09d — Tests + docs

12. **Tests**:
    - Deployment YAML schema (validation, error messages, env
      resolution).
    - Per-repo workflow loader (parsing, fallback when missing).
    - Multi-project FakeTracker fixtures (two projects, issues
      across both, ordering).
    - Orchestrator end-to-end with `FakeBackend`: a multi-project
      tick dispatches across both projects, FakeBackend records
      both starts, snapshot includes per-project breakdown.
    - Project-namespaced workspace path (extends existing
      `workspace/paths.test.ts`).

13. **Documentation**:
    - `README.md` — multi-project quickstart pointing at
      Plan 10 for "now make it actually run pods."
    - `examples/deployment/README.md` — operator setup walkthrough
      for the YAML.
    - `examples/repo-workflow/README.md` — repo-team setup
      walkthrough for the workflow.md schema.
    - `ARCHITECTURE.md` — update layer map for the new
      `execution/` layer + multi-tracker shape.
    - `docs/product-specs/deviations.md` — entries for §5 and
      §11.2 marked "Implemented" once Stage 09c lands.

## Definition of done

- ADR 0011 written and Accepted (Stage 09a — done).
- `ExecutionBackend` interface, errors, `FakeBackend`, and tests
  shipped under `packages/daemon/src/execution/` (Stage 09a —
  done).
- Deployment YAML schema parses a 2-project `symphony.yaml`
  fixture; per-repo workflow.md schema parses without operator
  fields; single-project compat mode loads today's
  `examples/linear/WORKFLOW.md` unchanged.
- Orchestrator end-to-end test with `FakeBackend` and 2 projects:
  both projects' issues dispatch via the same backend instance,
  per-project counters in the snapshot match expectations.
- Workspace paths are namespaced by project; verified by tests +
  one manual smoke run with the existing FakeAgent.
- Dashboard's "Running" panel groups by project (frontend
  change against the new `StateSnapshotWire` shape).
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean. Test count grows by ~30 (15 from Stage 09a already +
  ~15 across config / orchestrator / multi-tracker).
- ADR 0009 reflects any plan-time deviations (or recorded in
  `deviations.md`).

## Open questions

- **Per-project budgets — operator-side cap, repo-side override,
  or both?** Tentative: operator-side hard cap (deployment YAML),
  repo-side advisory floor (workflow.md). Effective cap =
  `min(operator_cap, repo_cap)`. Schema lands in this plan;
  the `min(...)` resolution is implemented by the agent-runtime
  in Plan 10.
- **Should the per-repo workflow loader be a daemon dependency
  or an agent-runtime dependency?** Agent-runtime, because the
  pod is what reads `workflow.md` after clone (per ADR 0011).
  This plan ships the parser as a standalone module that both
  the daemon (for dry-run validation) and the agent-runtime
  (Plan 10) can import.
- **Single-project compat mode and the new `execution.backend`
  field.** When the operator runs in legacy mode (one workflow
  path), what backend does the synthesized config use? Tentative:
  `fake` — legacy users were running the in-process MockAgent
  anyway. They opt into Docker by writing a `symphony.yaml`.
  Confirm during implementation.

## Decision log

- **2026-04-30 — Stage 09a complete.** ADR 0011 written and Accepted
  (`docs/design-docs/0011-agent-in-pod-and-execution-backend.md`).
  ExecutionBackend interface + supporting types scaffolded under
  `packages/daemon/src/execution/` (`backend.ts`, `errors.ts`,
  `index.ts`, `README.md`). FakeBackend implementation + 15 unit
  tests landed (`fake.ts`, `fake.test.ts`). Verification chain
  green: typecheck, lint, test (341/341), build, deps:check
  (11 warnings, all pre-existing pattern of type-only files
  flagged as orphans by dependency-cruiser — no new errors).

- **2026-04-30 — ADR 0011 refined: pod fetches from Linear, daemon
  ships only a dispatch envelope.** Original design had the daemon
  serialize the issue body and rendered prompt into `task.json`,
  with the pod just reading and running. User pushed back: the
  per-repo `workflow.md` template lives inside the cloned repo,
  which the daemon doesn't have until the pod clones it — so the
  daemon literally cannot render the prompt before pod start.
  Refined design: the pod re-fetches the issue from Linear,
  clones the repo, reads `workflow.md`, and renders the prompt
  itself. The daemon's responsibility shrinks to "decide which
  issue to dispatch with what envelope, then start a pod and
  observe events." Bonus consequence: Linear's state machine
  becomes the dispatch handshake (pod transitions to "In Progress"
  as its first act; daemon's next poll sees claimed; daemon
  restart is trivially safe with no reattach logic). Code impact:
  `TaskSpec` renamed to `DispatchEnvelope`, `prompt` and
  `allowedTools` removed, `tracker` + `repo` + `operatorCaps`
  fields added. `PodStartInput.task` renamed to `.envelope`.
  `dispatch.json` replaces `task.json` as the mounted file.
  Stage 09d step 11 rewritten to reflect the pod-side flow.
  Stage 09a code (FakeBackend + tests) updated to match.
  Verification chain re-run: still green.

- **2026-04-30 — Plan 09 split into four plans.** Original Plan 09
  ("multi-project + agent runtime + idempotency + PR demo") was
  ~2 weeks of work in one document. Reshape: this plan keeps the
  foundation (multi-project config + orchestrator + ExecutionBackend
  interface + FakeBackend); the agent-in-pod runtime + LocalDockerBackend
  becomes Plan 10; idempotent side effects become Plan 11; the
  live PR demo + Symphony self-hosting becomes Plan 12. Existing
  Plan 10 (deployable services) renumbered to Plan 13 to slot
  after the new plans. Each new plan is ~1-2 days, has its own
  test gate, and can move to `completed/` independently. Boundary
  rationale captured in the conversation 2026-04-30; in short:
  "what can be shown working between commits?" — Plan 09 → multi-
  project orchestrator with FakeBackend; Plan 10 → real Docker
  pod posts a Linear comment; Plan 11 → re-dispatch produces no
  duplicates; Plan 12 → live PR opens against real GitHub.
