# Plan 04 — Orchestrator skeleton + MockAgent

- **Status:** Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-28
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
   - In-memory map structures matching SPEC §4.1.8 fields. Per ADR
     0008, fields named `codex_*` in the spec (e.g. `codex_totals`,
     `codex_rate_limits`, `codex_app_server_pid`,
     `codex_input_tokens`, etc.) are renamed to `agent_*` for
     consistency with the schema rename.
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

- **2026-04-28** — Single-authority via a hand-rolled `AsyncLock` that
  chains promises. Every state mutation goes through `lock.run(...)`.
  Picking this over an external `async-mutex` library keeps the
  dependency surface small and makes the contract explicit (fewer
  "where does the magic happen" questions).
- **2026-04-28** — `OrchestratorState` is split into a _mutable_
  interior in `orchestrator/state.ts` and a read-only projection in
  `types/orchestrator-state.ts`. `snapshot()` copies maps/sets so
  consumers (HTTP API, dashboard) can hold a value without
  worrying about it changing under them.
- **2026-04-28** — Added a `drain()` method alongside `stop()`.
  `stop()` is forceful (aborts in-flight workers), `drain()` is
  graceful (just awaits them). Tests use `drain()` between `tick()`
  and assertions; SIGINT/SIGTERM handlers use `stop()`.
- **2026-04-28** — Eligibility split into structural (Plan 02
  `tracker/eligibility.ts`) + runtime (this plan,
  `orchestrator/eligibility.ts`). Structural cares about state /
  blockers / required fields; runtime adds already-running,
  already-claimed, and concurrency caps. Splitting it lets the
  Linear adapter (Plan 06) pre-filter at GraphQL using just the
  structural piece.
- **2026-04-28** — Per-state concurrency caps lookup uses
  `agent.max_concurrent_agents_by_state[normalizeState(issue.state)]`.
  Schema layer already lowercases the keys, so the lookup is
  consistent.
- **2026-04-28** — Worker tasks run as fire-and-forget promises
  (background-tracked in `this.workers: Map<IssueId, Promise<void>>`).
  They do NOT block the tick. `stop()` and `drain()` await all of
  them via `Promise.allSettled`.
- **2026-04-28** — Each worker has a per-issue `AbortController`
  whose signal threads through to the agent. Plan 05's stall
  detection will use it; for Plan 04 it only fires on `stop()`.
- **2026-04-28** — `agent.run()` returns an `AsyncIterable`, not a
  callback. Reason: streaming events fit naturally as a `for await`
  loop. The orchestrator processes one event at a time inside
  `lock.run(...)` so updates to the live session are serialized
  with everything else.
- **2026-04-28** — A failing agent run (`turn_failed` event)
  currently lands as a _normal_ exit because the iterable ends
  cleanly. Plan 05 will introduce the policy of treating any
  `turn_failed` as a failure-driven retry. Documented in the
  failing-agent test so the upcoming behavior change is visible.
- **2026-04-28** — Logger fallback: introduced `Logger` interface +
  console implementation in `observability/`. Tokens are redacted
  via a regex (`lin_*`, `sk-*`) at field-render time. Plan 08 may
  swap to `pino` for JSON output; the interface stays the same.
- **2026-04-28** — Updated `.dependency-cruiser.cjs` to allow
  `tracker/`, `workspace/`, and `agent/` to depend on
  `observability/` (the cross-cutting logger). ARCHITECTURE.md
  already described observability as cross-cutting; the rule was
  too tight.
- **2026-04-28** — Added `tracker.fixture_path` to the schema for
  fake-mode dev runs. Resolved through the same `~`/`$VAR` pipeline
  as `workspace.root` so fixtures can live under `~/symphony` or
  via env var.
- **2026-04-28** — Composition root in `index.ts` short-circuits
  when `tracker.kind === 'linear'` with a clear "arriving in Plan
  06" message. Better than a runtime crash when an operator copies
  a Linear-shaped WORKFLOW.md before Plan 06 lands.
- **2026-04-28** — Schema-side stall_timeout_ms must be ≥ 0; the
  example `WORKFLOW.md` sets it to `0` (disabled) for Plan 04
  because we don't have stall detection yet. Plan 05 will turn it
  on by default.
- **2026-04-28** — Live smoke test passed: 8-second run produced
  three full ticks (interval 3s), dispatched SYMP-1 and SYMP-2,
  correctly skipped SYMP-3 (blocked) and SYMP-4 (terminal),
  streamed agent events, exited cleanly on SIGINT with exit 0.
  Workspaces created under `examples/fake/.symphony-workspaces/`
  with `after_create` and `before_run` hooks observed running.
- **2026-04-28** — Final test count: 183 across 21 files (was 155
  after Plan 03). `pnpm deps:check` orphan warnings dropped from
  10 to 9 (orchestrator now wires the workspace manager).
