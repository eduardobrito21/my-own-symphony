# `tracker/` — issue tracker adapters

Fetches issues from external trackers and normalizes them into the
domain `Issue` type. Implementations live in subdirectories.

## Subdirectories

- `tracker.ts` — the `Tracker` interface and shared error types.
- `fake/` — the in-memory `FakeTracker` used for development and tests.
- `linear/` — the Linear GraphQL adapter (Plan 06).

## Allowed dependencies

- `types/`, `config/` — yes.
- Anything else in this package — **no**.

## Why this rule

Trackers are leaves: they fetch and normalize. They do not decide what
to do with what they fetch. Decisions live in `orchestrator/`.

Per ADR 0007, both `FakeTracker` and the Linear adapter implement the
same interface. The composition root in `index.ts` selects between
them.
