# `execution/` — agent pod lifecycle

The execution layer is the seam ADR 0011 introduces. The
orchestrator hands an `ExecutionBackend` the inputs needed to
start a pod with the agent already running inside it; the backend
is responsible for image resolution, pod start/stop, and exposing
the pod's `AgentEvent` stream.

## Files

- `backend.ts` — the `ExecutionBackend` interface plus
  `ImageSpec` / `ImageRef` / `PodStartInput` / `PodHandle` /
  `TaskSpec` and the `podNameFor` helper.
- `errors.ts` — discriminated `ExecutionError` union and the
  `ExecutionResult<T>` shape every method returns.
- `fake.ts` — `FakeBackend`, used in orchestrator tests so they
  don't need a docker daemon. Same role as `tracker/fake/`.
- `local-docker/` — production backend that shells to the `docker`
  CLI. Lands in Plan 09 stage 09c.

## Allowed dependencies

- `types/`, `agent/` (for `AgentEvent` only) — yes.
- `config/` — yes (image resolution reads project settings).
- Anything else in this package — **no**. The orchestrator
  composes this layer with the others; this layer must not know
  about workspaces, trackers, or orchestration state.

## Contract reminders (see ADR 0011)

1. `start()` is **idempotent on `(projectKey, issueId)`**: same
   inputs → same handle. This is what makes daemon-restart-mid-run
   safe — the daemon comes back up and reattaches rather than
   spawning a duplicate pod.
2. `stop()` is **idempotent**: safe on a pod that's already gone.
3. The pod's event stream **terminates naturally** on the agent's
   terminal event (`turn_completed` / `turn_failed`) or on abort.
   Consumers do not need to call `stop()` after natural
   termination — the backend cleans up.
4. `ensureImage()` does **not auto-build** in v1. Image absent →
   `image_not_found` with an actionable message ("run `pnpm
docker:build:<projectKey>` then retry").
