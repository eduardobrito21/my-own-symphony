# Plan 05 — Retries, reconciliation, dynamic reload

- **Status:** Not started
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

- **Watch via `chokidar` or `node:fs.watch`?** `chokidar` is more
  reliable across editors that do atomic-write replace. Decide before
  starting: probably `chokidar`, but verify it's still maintained and
  has no native dependencies that complicate Docker later.

## Decision log

(empty)
