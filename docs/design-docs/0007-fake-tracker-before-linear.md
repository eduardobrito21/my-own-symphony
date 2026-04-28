# 0007 — Implement a `FakeTracker` before the real Linear adapter

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The orchestrator's correctness depends on:

- Issue eligibility logic (state filters, blockers, sort order).
- Concurrency limits (global and per-state).
- Reconciliation (terminal state cleanup, non-active termination).
- Retry semantics (continuation vs failure-driven backoff).
- Stall detection.

All of this can be exercised without a real Linear API. Driving
Phase 4 (orchestrator) with the real Linear adapter would couple two
unrelated learning curves (state-machine modeling and Linear's GraphQL
schema) and slow both.

## Decision

Implement a `FakeTracker` first. The orchestrator and all reconciliation
tests use it through Phase 6.

- Both `FakeTracker` and the eventual Linear adapter implement the same
  `Tracker` interface defined in `packages/daemon/src/tracker/tracker.ts`.
- `FakeTracker` is in-memory: a constructor takes an initial set of
  issues, mutators allow tests to change states between ticks.
- The composition root (`packages/daemon/src/index.ts`) selects between
  trackers based on configuration. By default we pick Linear when
  `tracker.kind === 'linear'`, fake otherwise.

The Linear adapter is implemented in **Phase 6**, after the orchestrator
is provably correct against the fake.

## Alternatives considered

1. **Skip the fake; use Linear from day one.** Couples orchestrator
   tests to network availability and Linear credentials. Slows the
   tight feedback loop the orchestrator's state machine needs.
   Rejected.
2. **Use a `nock`-style HTTP mock.** Tests at the wrong level. We want
   to verify the orchestrator's logic, not Linear's wire format.
   Rejected.

## Consequences

**Easier:**

- Orchestrator unit tests run in milliseconds with no credentials.
- The `Tracker` interface is forced to be small and behavior-focused
  early; we don't accidentally leak Linear-shaped types into the
  orchestrator.
- Adding a future tracker (Jira, GitHub Projects, ClickUp) requires
  only a new implementation of the interface.

**Harder:**

- The interface itself is a load-bearing decision; if it's shaped
  wrong, both the fake and Linear suffer. We mitigate by writing the
  interface against the spec's required operations (§11.1) rather than
  against Linear's schema.

**Constrained:**

- The `FakeTracker` is **not** test-only. It ships with the daemon and
  is the default when `tracker.kind` is missing. This makes it useful
  for local development against a fixture file.

## Implementation notes

- `FakeTracker` lives in `packages/daemon/src/tracker/fake/`.
- Linear adapter lives in `packages/daemon/src/tracker/linear/`.
- Both export a single factory function used by the composition root.
- Fixture issues for `FakeTracker` are defined in
  `packages/daemon/src/tracker/fake/fixtures/` and are
  loaded only when the daemon starts in fake mode.
