# `http/` — HTTP API for observability

Exposes orchestrator state via Fastify-served JSON routes under
`/api/v1/*`. Per [`ADR 0003`](../../../../docs/design-docs/0003-two-process-architecture.md),
this is the daemon's only outward-facing interface — the dashboard
runs as a separate process and consumes these routes.

## Files (planned)

- `server.ts` — Fastify setup, port binding, logging integration.
- `schemas.ts` — zod schemas for response shapes (re-exported via
  `@symphony/types` for the dashboard).
- `routes/state.ts` — `GET /api/v1/state` (full snapshot).
- `routes/issue.ts` — `GET /api/v1/:identifier` (issue detail).
- `routes/refresh.ts` — `POST /api/v1/refresh` (trigger tick).

## Allowed dependencies

- `types/`, `orchestrator/`, `observability/` — yes.
- `tracker/`, `workspace/`, `agent/` — **no**. Reach those through the
  orchestrator only.

## Why this rule

The HTTP layer adapts orchestrator state to HTTP. If it reaches into
`tracker/` directly, we're inverting the architecture: a request
handler running on a Node IO thread would race with the orchestrator's
state mutations. Going through the orchestrator forces every request
to go through the single-authority mutator.

## Posture

- Loopback by default. See [`SECURITY.md`](../../../../SECURITY.md).
- All routes are read-only except `/refresh`.
- Errors use `{ error: { code, message } }` envelope.
