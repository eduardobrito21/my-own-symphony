# `orchestrator/` — coordination authority

The single mutable-state authority. Polls the tracker, decides what to
dispatch, manages retries, reconciles against tracker changes, and
detects stalls.

## Files (planned)

- `state.ts` — `OrchestratorState` shape (per SPEC §4.1.8).
- `orchestrator.ts` — the `Orchestrator` class (single-authority
  mutator).
- `eligibility.ts` — `isEligible` and `sortForDispatch` helpers.
- `retry.ts` — retry queue and backoff.
- `reconcile.ts` — tick-time reconciliation against tracker state.
- `startup.ts` — startup terminal-cleanup sweep.

## Allowed dependencies

- `types/`, `config/`, `tracker/`, `workspace/`, `agent/` — yes.
- `http/` — **no**. HTTP exposes orchestrator state; not the reverse.
- `observability/` — yes (cross-cutting).

## Why this rule

There must be **one** place where scheduling decisions are made. If a
non-orchestrator layer can mutate dispatch state, races become
possible. The orchestrator's mutator methods are awaited in turn,
which is what gives Symphony its "single-authority" property even in
an asynchronous runtime.

This is also why the HTTP layer cannot mutate state directly: it
calls orchestrator methods that go through the same serialized path
as poll ticks.
