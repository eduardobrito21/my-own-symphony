# Reliability

This document describes Symphony's failure model: what kinds of failures the
system anticipates, how it responds to each, and what guarantees it provides
under degraded conditions.

The behavior described here is binding. If implementation drifts from this
document, fix the implementation — or update this document with an ADR
explaining why the behavior changed.

## Failure classes

Borrowed from [SPEC §14.1](docs/product-specs/symphony-spec.md), with
implementation-specific notes.

### 1. Workflow / config failures

Examples: missing `symphony.yaml`, malformed YAML, no projects declared,
missing `LINEAR_API_KEY`, missing `ANTHROPIC_API_KEY`, unknown
`execution.backend` value.

- **Startup**: fail fast with a typed error and a clear operator-visible
  message. Do not start the polling loop with a broken config.
- **At runtime**: dynamic reload of `symphony.yaml` is not yet implemented
  (the legacy `WORKFLOW.md` watcher was removed in the Plan 10 consolidation).
  Restart the daemon to pick up config changes.

### 2. Workspace failures

Examples: cannot create workspace dir, hook timeout, hook non-zero exit, path
outside the workspace root.

- `after_create` failure → fatal to workspace creation; the run attempt fails.
- `before_run` failure → fatal to the current attempt; retry with backoff.
- `after_run` failure → logged, ignored.
- `before_remove` failure → logged, ignored; cleanup proceeds.
- Path-containment violation → run aborts before agent launch.

### 3. Agent session failures

Examples: SDK initialization error, turn timeout, agent process exit, stalled
session (no events for `agent.stall_timeout_ms`).

- Worker exits abnormally → orchestrator schedules a retry with exponential
  backoff: `min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Worker exits normally but the issue is still in an active state → orchestrator
  schedules a short continuation retry (~1s) on the same workspace.
- Stall detection runs every poll tick; stalled workers are killed and retried.

### 4. Tracker failures

Examples: Linear transport error, non-200 response, GraphQL errors,
unparseable payload.

- Candidate fetch failure → skip dispatch for this tick. Try again next tick.
- State refresh failure → keep current workers running. Try again next tick.
- Startup terminal-cleanup failure → log a warning and continue startup.

### 5. Observability failures

Examples: log sink error, snapshot collection timeout, dashboard unavailable.

- Log sink errors do not crash the orchestrator. If multiple sinks are
  configured, the remaining ones continue receiving events.
- The dashboard is observability-only. Its absence or unreachability cannot
  block scheduling, dispatch, or reconciliation.

## Retry semantics

Two distinct retry types, with different delays:

| Type                 | When                                                     | Delay                                                                               |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Continuation retry   | Worker exited normally; issue still in an active state.  | Fixed 1000 ms.                                                                      |
| Failure-driven retry | Worker exited abnormally, or workspace/preflight failed. | `min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`. Default cap: 5 minutes. |

Retry timers are in-memory only. They do not survive a process restart; recovery
relies on a fresh poll picking up still-active issues.

## Stall detection

Per running issue, every tick:

```
elapsed = now - (lastEventAt ?? startedAt)
if elapsed > agent.stallTimeoutMs:
  terminate worker
  schedule failure-driven retry
```

If `agent.stallTimeoutMs <= 0`, stall detection is disabled (used for tests
and rare production debug scenarios).

## Reconciliation against the tracker

Every tick, the orchestrator refreshes the state of every running issue:

- Tracker says state is **terminal** → terminate the worker and remove the
  workspace.
- Tracker says state is still **active** → update the in-memory snapshot.
- Tracker says state is something **else** (paused, custom workflow state) →
  terminate the worker but keep the workspace.

Tracker refresh failures are non-fatal: keep workers running, retry next tick.

## What survives a process restart

Symphony is intentionally **stateless** between processes. After restart:

- All retry timers are forgotten.
- All running sessions are forgotten.
- Workspaces remain on disk, including any commits or files the agent left.
- The next poll cycle re-discovers active issues and re-dispatches eligible
  ones.
- Startup terminal-cleanup sweeps stale workspaces for issues already in
  terminal states.

This is by design: a durable scheduler database adds operational weight
disproportionate to the cost of "lose your retry timers, run another tick."

## Liveness invariants

These should always hold; their violation is a bug:

- The polling loop does not block on a single tracker call. A slow tracker
  delays the next tick; it does not deadlock the orchestrator.
- A stuck agent does not stall the orchestrator. Stall detection enforces this
  on a fixed cadence.
- A failing dashboard request cannot pause dispatch. The HTTP layer never
  shares a thread of execution with the orchestrator's state mutations.
- The orchestrator's config is loaded once at startup and is immutable for
  the daemon's lifetime. There is no in-flight config reload.

## Operator levers

When something is wrong, an operator has two direct tools:

1. **Change tracker state** — moving an issue to a terminal state stops its
   running session and cleans the workspace at the next reconciliation.
2. **Restart the daemon** — for process recovery, deployment, or applying
   `symphony.yaml` / `.symphony/workflow.md` changes (no live reload).

## What this document does not cover

- The Symphony spec defines additional behaviors that this implementation
  may not implement (durable retry queue, SSH worker pool, etc.). Those are
  tracked in `docs/exec-plans/` and noted in
  `docs/product-specs/deviations.md`.
