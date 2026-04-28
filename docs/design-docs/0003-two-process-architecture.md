# 0003 — Daemon and dashboard run as separate processes

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The Symphony spec's §13.7 describes an optional HTTP server that exposes
a human-readable dashboard at `/` and a JSON API under `/api/v1/*`. The
upstream Elixir implementation embeds Phoenix LiveView in the same OTP
application as the orchestrator.

For this implementation, the dashboard is built with Next.js (App Router)
to teach React + Next.js to the operator. There are two ways to combine a
Next.js app with a Node daemon:

1. **One process** — embed Next.js's custom-server mode inside the daemon
   so a single Node process serves both the API and the dashboard.
2. **Two processes** — the daemon exposes a JSON API; a separate Next.js
   app consumes it.

## Decision

Run the daemon and the dashboard as **two separate processes**.

- The daemon (`packages/daemon`) exposes Fastify-served routes under
  `/api/v1/*` and binds to a local port. It has zero React or Next.js
  dependencies.
- The dashboard (`packages/dashboard`, added in Phase 8) is a Next.js
  App Router app. Server components fetch from the daemon's API; client
  components handle live updates.
- Communication is HTTP only.

## Alternatives considered

1. **Embed Next.js inside the daemon** — would mirror the upstream Elixir
   approach more closely but tangles UI framework concerns into the
   orchestrator process. Cold-start latency, dependency surface, and
   debugging complexity all increase. Rejected.
2. **Daemon serves a static SPA** — would simplify deployment but loses
   the React Server Components / streaming SSR features that are part
   of why the dashboard uses Next.js (the operator wants to learn
   App Router patterns). Rejected.

## Consequences

**Easier:**

- Daemon stays small. Its dependency tree is `fastify`, `pino`, `zod`,
  the Claude Agent SDK, plus a GraphQL client — nothing UI-related.
- The dashboard can be developed, tested, and deployed independently.
- Killing the dashboard never affects orchestrator correctness; the
  spec's §13.7 mandate ("dashboard MUST NOT become required for
  orchestrator correctness") is satisfied by construction.

**Harder:**

- Two processes to start in development (or one `pnpm` script that
  spawns both).
- Two Docker images at deploy time (acceptable; deferred to Phase 9).
- Slightly more boilerplate to share types between the two processes —
  solved by the `packages/types` shared package.

**Constrained:**

- The dashboard cannot poke at orchestrator state directly. Every
  operation goes through the JSON API. This is a feature, not a bug:
  it forces the API surface to be complete enough to support a UI.

## Implementation notes

- The daemon binds loopback (`127.0.0.1`) by default. Exposing it on
  another interface requires explicit config; see `SECURITY.md`.
- Live updates: the dashboard polls every few seconds initially. SSE or
  WebSocket may be added later if polling cost matters.
- Shared types live in `packages/types`; both processes consume them.
