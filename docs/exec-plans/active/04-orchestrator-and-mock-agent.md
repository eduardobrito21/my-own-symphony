# Plan 04 — Orchestrator skeleton + MockAgent

- **Status:** Not started
- **Spec sections:** §3.1 (Main Components), §7 (Orchestration State
  Machine), §8 (Polling, Scheduling, and Reconciliation), §16
  (Reference Algorithms)
- **Layers touched:** `orchestrator/`, `agent/` (mock implementation),
  `observability/`

## Goal

Stand up the polling loop, single-authority state, dispatch logic,
and a `MockAgent` that simulates running. After this plan, end-to-end
flow works: `pnpm dev` launches the daemon against a fake tracker and
mock agent, ticks every poll interval, dispatches issues into mock
"runs," and emits a structured log of events.

## Out of scope

- Retries with backoff. Plan 05.
- Reconciliation against tracker state changes. Plan 05.
- Stall detection. Plan 05.
- Dynamic workflow reload. Plan 05.
- Real Linear or real Claude. Plans 06 and 07.

## Steps

1. **`AgentRunner` interface** in
   `packages/daemon/src/agent/runner.ts`:
   - `run(input: AgentRunInput): AsyncIterable<AgentEvent>`.
   - `AgentRunInput` includes the prepared workspace path and the
     rendered prompt.
   - `AgentEvent` is a discriminated union covering at minimum
     `session_started`, `turn_completed`, `turn_failed`, `notification`.
2. **`MockAgent`** in `packages/daemon/src/agent/mock/`:
   - Configurable: turn duration, success/failure outcome, optional
     emitted notifications.
   - Useful as a test double and for `pnpm dev` against fixtures.
3. **`OrchestratorState`** in
   `packages/daemon/src/orchestrator/state.ts`:
   - In-memory map structures matching §4.1.8 fields.
   - All state mutations happen through a single `Orchestrator` class;
     mutator methods are the only public surface.
4. **Single-authority orchestrator** in
   `packages/daemon/src/orchestrator/orchestrator.ts`:
   - Owns the tick scheduler (`setTimeout` chained, never `setInterval`).
   - Mutator methods: `onTick`, `onWorkerExit`, `onAgentEvent`,
     `dispatchIssue`, `terminateRunning`. Each is `async` and
     awaited in turn so concurrent inputs serialize.
   - Public API: `start()`, `stop()`, `snapshot()`.
5. **Eligibility and sort helpers** (could live in `orchestrator/` or
   be lifted from Plan 02 helpers):
   - `isEligible(issue, state, config)`.
   - `sortForDispatch(issues)`.
6. **Composition root** in `packages/daemon/src/index.ts`:
   - Read CLI args (workflow file path).
   - Load workflow config.
   - Construct `FakeTracker` (default) or Linear tracker (Plan 06).
   - Construct `MockAgent`.
   - Construct workspace manager.
   - Construct orchestrator with all collaborators.
   - Wire structured logging via `observability/`.
   - `await orchestrator.start()`; handle `SIGINT`/`SIGTERM`.
7. **Tests** under `orchestrator/*.test.ts`:
   - One full tick: candidate issues → dispatch → MockAgent run →
     normal exit → `completed` set updated.
   - Concurrency limit honored: `max_concurrent_agents=1` allows only
     one in-flight run.
   - Per-state limit overrides global limit.
   - Eligibility filters: `Todo` with non-terminal blocker is skipped.
   - Snapshot returns the expected fields per spec §13.3.

## Definition of done

- `pnpm test packages/daemon/src/orchestrator` passes including at
  least one multi-tick scenario.
- `pnpm dev path/to/test-WORKFLOW.md` runs against a fake tracker and a
  mock agent, ticks for ~30 seconds, and exits cleanly on SIGINT with
  no leaked timers or child processes.
- `pnpm deps:check` passes.
- Structured logs include `issue_id`, `issue_identifier`, and
  `session_id` (mock-generated) per spec §13.1.

## Open questions

- **State serialization.** Should `snapshot()` produce a copy of state,
  or expose state via an interface? Decision: copy; the snapshot is
  data, not a live view. Captured here so we don't relitigate.

## Decision log

(empty)
