# Plan 05 — Retries, reconciliation, dynamic reload

- **Status:** Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-28
- **Spec sections:** §6.2 (Dynamic Reload Semantics), §7.4
  (Idempotency and Recovery Rules), §8.4 (Retry and Backoff), §8.5
  (Active Run Reconciliation), §8.6 (Startup Terminal Workspace
  Cleanup)
- **Layers touched:** `orchestrator/`, `config/` (watch), `workspace/`
  (cleanup integration)

## Goal

Make the orchestrator resilient: failed runs retry with exponential
backoff, normal exits get short continuation retries, tracker state
changes are reconciled every tick, stalled runs are killed, and editing
`WORKFLOW.md` reapplies new config without a restart.

## Out of scope

- Real Linear or real Claude. Still using fakes.
- HTTP API. Plan 08.
- Persisted retry queue. Per `RELIABILITY.md`, we explicitly do not
  persist scheduler state.

## Steps

1. **Retry queue** in `packages/daemon/src/orchestrator/retry.ts`:
   - `RetryEntry` per spec §4.1.7.
   - `scheduleRetry(state, issueId, attempt, opts)`.
   - Backoff formula:
     - Continuation: 1000 ms fixed.
     - Failure: `min(10000 * 2^(attempt - 1), maxRetryBackoffMs)`.
   - Cancel an existing timer when scheduling a new one for the same
     issue.
2. **Worker exit handling**:
   - Normal exit → `completed.add(issueId)`, schedule continuation
     retry.
   - Abnormal exit → schedule failure-driven retry.
   - In both cases, accumulate runtime seconds into `agent_totals`
     (renamed from spec's `codex_totals` — see ADR 0008).
3. **Reconciliation** in
   `packages/daemon/src/orchestrator/reconcile.ts`:
   - Stall detection: per running issue, if
     `now - (lastEventAt ?? startedAt) > stallTimeoutMs`, terminate.
   - Tracker state refresh: fetch all running issue IDs, classify each
     as terminal / active / other, terminate accordingly.
   - On tracker fetch failure, do not mutate; log and continue.
4. **Startup terminal cleanup** in
   `packages/daemon/src/orchestrator/startup.ts`:
   - Fetch issues in terminal states, remove their workspaces.
   - Failure logs a warning and proceeds.
5. **Dynamic reload** in `packages/daemon/src/config/watch.ts`:
   - `chokidar` watcher on the resolved workflow path.
   - Debounce; on event, re-load and re-validate.
   - On success, swap the orchestrator's effective config; new values
     apply on the next tick (poll interval, concurrency, etc.).
   - On failure, keep last-known-good config and emit an
     operator-visible error.
6. **Tests** (heavily timer-driven; use vitest's fake timers):
   - Continuation retry fires ~1s after a normal exit.
   - Failure-driven backoff: attempt 1 = 10s, 2 = 20s, 3 = 40s, …
     capped at `maxRetryBackoffMs`.
   - Reload of a valid workflow updates poll interval immediately.
   - Reload of a malformed workflow keeps the last-known-good config
     and logs the parse error.
   - Stall timeout fires and queues a retry.
   - Reconciliation moves a running issue to terminated when the
     tracker reports terminal state.

## Definition of done

- All tests pass deterministically with vitest fake timers.
- A manual e2e dry-run with FakeTracker + MockAgent demonstrates each
  retry / reconcile / reload behavior visibly in the structured logs.
- `pnpm deps:check` passes.

## Open questions

- ~~**Watch via `chokidar` or `node:fs.watch`?**~~ Resolved:
  `chokidar` v4. Pure JS, no native deps (good for Plan 09 Docker),
  handles atomic-write rename cleanly.

## Decision log

- **2026-04-28** — `chokidar@^4.0.3`. Listens for `change` and
  `add` events (the latter handles editors that do atomic-write
  rename). Debounces 300 ms by default — most editors fire 2–5
  events per save and we want one reload.
- **2026-04-28** — Retry queue lives in `orchestrator/retry.ts` as
  pure helpers (`scheduleRetry`, `cancelRetry`, `computeDelay`).
  The orchestrator owns the timer lifecycle; this file is the math
  - state-mutation logic.
- **2026-04-28** — Reconciliation in `orchestrator/reconcile.ts`
  exposes two callbacks (`onTerminate`, `onStall`) so the
  orchestrator can decide HOW to terminate without baking that
  policy into the reconcile module. Keeps reconcile testable in
  isolation if we ever want.
- **2026-04-28** — Stall vs reconciliation termination:
  - Stall: just abort the worker. The worker's abnormal exit goes
    through the normal `completeWorker` path and schedules a
    failure-driven retry. Simple, no special state needed.
  - Reconciliation termination: add to `canceled` Set, abort,
    drop claim, optionally remove workspace. `completeWorker`
    sees the canceled flag and skips retry scheduling.
- **2026-04-28** — Continuation retry delay = 1000 ms fixed (per
  SPEC §8.4). Failure-driven backoff uses
  `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`. Attempt = 1
  is the FIRST failure (so first failure delay is 10s, not 0s).
- **2026-04-28** — In Plan 04 a `turn_failed` event landed as a
  _normal_ exit because the iterable ended cleanly. Plan 05 keeps
  that behavior: the orchestrator looks at how the iterable ended
  (cleanly vs throwing), not at the event payload. Plan 07 may
  introduce policy that maps `turn_failed` to abnormal — we'll
  do that as part of the Claude SDK integration.
- **2026-04-28** — `WorkspaceManager.setHooks()` mutator added so
  reload can swap hook scripts in place. In-flight hooks keep
  their original config (we don't try to re-target a process
  mid-execution).
- **2026-04-28** — `applyWorkflow` reschedules the next tick when
  `polling.interval_ms` changes. Reschedules use the same path as
  initial scheduling — clear current handle, install a new one
  with the new interval. Rationale: faster operator feedback when
  experimenting with intervals.
- **2026-04-28** — Schema bug fix in MockAgent: the
  `never_completes` branch checked `signal.aborted` only after
  registering the abort listener, which would hang if abort fired
  during the previous yield. Now we check `signal.aborted` first
  and throw immediately. Found via the Plan 05 stall test.
- **2026-04-28** — `dependency-cruiser` config updated to allow
  `tracker/`, `workspace/`, and `agent/` to depend on
  `observability/` (the cross-cutting logger layer). Already
  documented in ARCHITECTURE.md but the lint config was out of
  sync.
- **2026-04-28** — Final test count: 205 tests across 25 files
  (was 183 after Plan 04). New tests:
  - `retry.test.ts` — 9 tests (delay math, schedule, cancel)
  - `orchestrator-plan05.test.ts` — 7 tests (retry behaviors,
    reconciliation terminations, stall detection, applyWorkflow)
  - `startup.test.ts` — 3 tests (terminal cleanup sweep)
  - `watch.test.ts` — 3 tests (chokidar reload + debounce)
- **2026-04-28** — Live smoke verified all behaviors visibly:
  startup terminal cleanup, continuation retries firing on a 1s
  delay, retry_released_claim when issues are still claimed,
  workflow_reloaded log line after editing the file mid-run,
  ticks at the new interval after reload, clean SIGINT shutdown.
- **2026-04-28** — `pnpm deps:check` orphans: 9 (same as Plan 04;
  the new files are imported into the orchestrator and composition
  root, so no new orphans introduced).
