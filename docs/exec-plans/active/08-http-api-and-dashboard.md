# Plan 08 — HTTP API and Next.js dashboard

- **Status:** Not started
- **Spec sections:** §13.7 (Optional HTTP Server Extension)
- **Layers touched:** `http/` (new), `packages/dashboard` (new)

## Goal

Add the OPTIONAL HTTP API to the daemon and ship a Next.js dashboard
that consumes it. After this plan, an operator can hit
`http://localhost:<port>/api/v1/state` to get a JSON snapshot, or open
the dashboard URL to see a human-readable view of the same data.

This plan ships in two stages. **Do not start 08b before 08a is in
`completed/`.**

## Stage 08a — daemon HTTP API

### Steps

1. **Fastify setup** in
   `packages/daemon/src/http/server.ts`:
   - Bind loopback `127.0.0.1` by default.
   - Register `pino` for HTTP logging.
   - Read port from CLI `--port` (preferred) or `server.port` config.
2. **Routes** in `packages/daemon/src/http/routes/`:
   - `GET /api/v1/state` — orchestrator snapshot (spec §13.7.2 shape).
   - `GET /api/v1/:identifier` — single-issue debug detail.
   - `POST /api/v1/refresh` — trigger immediate poll/reconcile.
3. **Schemas** in `packages/daemon/src/http/schemas.ts`:
   - One zod schema per response shape.
   - Schemas exported from `packages/types` for reuse by the dashboard.
4. **Composition root**:
   - Conditionally start the HTTP server based on `--port` /
     `server.port`.
5. **Tests**:
   - Unit tests for each route, mocking the orchestrator.
   - Verify error envelope `{ error: { code, message } }` for unknown
     issues and unsupported methods.

### Definition of done (08a)

- `curl http://localhost:<port>/api/v1/state` returns the snapshot
  shape from spec §13.7.2.
- `404` for unknown issues includes `{ error: { code, message } }`.
- `405` for unsupported methods on defined routes.
- `pnpm deps:check` passes; `http/` only depends on `types/`,
  `orchestrator/`, `observability/`.

## Stage 08b — Next.js dashboard

### Steps

1. **Package setup** in `packages/dashboard/`:
   - Next.js App Router, TypeScript, eslint, prettier inheriting from
     the workspace.
   - `next.config.mjs` with `experimental.serverComponentsExternalPackages`
     as needed for our shared types.
2. **Add dashboard to root `tsconfig.json` references** and to
   `pnpm-workspace.yaml` (already covered).
3. **Routes** under `packages/dashboard/app/`:
   - `/` — overview: running, retrying, totals.
   - `/issue/[identifier]` — issue detail view.
4. **Data fetching**:
   - Server components fetch from
     `process.env.SYMPHONY_DAEMON_URL` (default `http://localhost:3000`).
   - Client components handle revalidation via `swr` or React's
     `useState` polling on a fixed interval.
5. **Types**:
   - Import response types from `packages/types/src/http.ts`.
   - Render with strict null handling.
6. **Manual checks**:
   - Run daemon + dashboard simultaneously via a root `pnpm dev` script
     (`concurrently` or similar).
   - Verify the dashboard reflects orchestrator state after dispatch.

### Definition of done (08b)

- `pnpm dev` starts both the daemon and the dashboard.
- Dashboard renders running and retrying issues from the live API.
- Dashboard cannot mutate orchestrator state (read-only except for
  triggering `/refresh`).
- Lighthouse-style smoke check that the dashboard renders without
  console errors. (Manual; no Lighthouse automation required.)

## Out of scope

- SSE / WebSocket real-time updates. Polling is fine for v1.
- Authentication. Loopback-only by default; if the operator exposes
  the API externally, that's their responsibility.
- Production deployment. Plan 09.

## Open questions

- **Dashboard rendering strategy.** Default to mostly RSC with small
  client islands for live data. Reconsider if the polling pattern
  feels awkward.

## Decision log

(empty)
