# Plan 08 — HTTP API and Next.js dashboard

- **Status:** ✅ Complete (basic working version per user's "ship fast" directive)
- **Started:** 2026-04-29
- **Completed:** 2026-04-29
- **Spec sections:** §13.7 (Optional HTTP Server Extension)
- **Layers touched:** `packages/daemon/src/http/` (new),
  `packages/dashboard/` (new top-level package), root scripts
- **ADRs referenced:** 0006 (zod at every boundary). New ADR pending:
  0010 — "Co-located HTTP server is provisional; will split in
  Plan 9+10".

## Outcome

Working overview dashboard at `http://localhost:3001` that polls a
read-only `GET /api/v1/state` endpoint on the daemon and renders
running / retrying / totals / completed panels in a dense dark UI.
Auto-refreshes every 2s. Survives daemon restarts gracefully (red
banner, last-known state still visible).

327 tests green; +9 in `daemon/src/http/server.test.ts`. No new
backend deps (used Node's built-in `http`, not Fastify).

## What we learned

1. **The "two responsibilities" smell is real and worth flagging.**
   Putting an HTTP server inside the daemon's process couples
   execution and observability planes that should be independent
   (different restart cadences, different blast radii, different
   trust boundaries). Right call for v1; document why; split in
   Plan 9+10. The dashboard already imports nothing from the
   daemon — half the split is mechanical.
2. **Deployment config doesn't belong in WORKFLOW.md.**
   `server.port` was originally a top-level YAML field; user
   correctly objected ("why is the server port definition in the
   workflow md?"). Moved to env vars
   (`SYMPHONY_HTTP_PORT`, `SYMPHONY_HTTP_HOST`). The general rule:
   the same workflow file should be portable across daemon
   instances. Anything that pins a port, a host, or a path is a
   deployment decision.
3. **JSON-encoding `Map`/`Set` is the boundary's first job.**
   `OrchestratorState` is full of `Map`/`Set`/`Date`. Default
   `JSON.stringify` silently drops them as `{}`. The wire
   serializer (`http/serialize.ts`) is the place to convert once,
   typed, with a wire shape the dashboard mirrors. Tests assert
   the round-trip.
4. **No Fastify needed.** Two routes don't justify a framework.
   Built-in `node:http` + a small dispatcher table is ~50 lines,
   no deps to ship in the daemon's container.
5. **Polling at 2s is fine.** No SSE, no WebSocket, no streaming.
   Sixty requests/min on loopback for a single dashboard tab is
   nothing. The dashboard's "graceful offline" (keep last state +
   red banner) cost ~5 lines.

## Goal

Add the OPTIONAL HTTP API to the daemon and ship a Next.js dashboard
that consumes it. After this plan, an operator can hit
`http://localhost:3000/api/v1/state` to get a JSON snapshot, or open
the dashboard at `http://localhost:3001` to see a human-readable
view of the same data.

## Stages (as built)

### Stage 08a — daemon HTTP API ✅

Built in `packages/daemon/src/http/`:

1. **`server.ts`** — minimal HTTP server using Node's built-in
   `http.createServer`. No Fastify dependency; two routes don't
   warrant a framework. Binds `127.0.0.1` by default. CORS:
   `Access-Control-Allow-Origin: *` (read-only on loopback; the
   dashboard runs on a different port and needs cross-origin).
2. **Routes** (in `server.ts`'s `handleRequest` dispatcher):
   - `GET /api/v1/health` → `{ "status": "ok" }`. Health probe.
   - `GET /api/v1/state` → full orchestrator snapshot in wire
     shape. Maps unrolled to arrays-of-records, Sets to arrays,
     Dates to ISO strings, retry due-times projected from the
     monotonic clock onto wall-clock for human display.
   - `OPTIONS *` → 204 with CORS headers (preflight).
   - `405` for non-GET methods on known endpoints.
   - `404` with `{ error: { code, message } }` for unknown paths.
3. **`serialize.ts`** — pure conversion from `OrchestratorState`
   to `StateSnapshotWire`. The wire types (`IssueWire`,
   `LiveSessionWire`, `RunningEntryWire`, `RetryEntryWire`,
   `AgentTotalsWire`, `StateSnapshotWire`) are the documented
   contract. The dashboard mirrors them in `app/api-types.ts`.
4. **Composition root** — `maybeStartHttpServer` in `index.ts`
   reads `SYMPHONY_HTTP_PORT` from env. Unset = no port open.
   Optional `SYMPHONY_HTTP_HOST` overrides the loopback bind.
5. **Tests** — `server.test.ts`: boot real server on port `0`,
   hit it with `fetch`, assert status codes + payload shapes for
   all routes including a non-trivial running / retrying /
   completed snapshot.

### Stage 08b — Next.js dashboard ✅

Built in `packages/dashboard/` (new top-level package, auto-picked
up by `pnpm-workspace.yaml`):

1. **`package.json`** — Next.js 15, React 19, no UI framework. Plain
   CSS. Runs on `:3001` by default (daemon on `:3000`).
2. **`next.config.mjs`** — exposes `SYMPHONY_DAEMON_URL` to the
   client (default `http://127.0.0.1:3000`).
3. **`app/layout.tsx`, `app/page.tsx`** — single overview page,
   no per-issue detail (deferred). Three panels in a 2:1 grid.
4. **`app/use-snapshot.ts`** — `useEffect`-based 2s polling hook.
   Returns `{ snapshot, error, lastFetchedAt }`. On fetch failure
   keeps the last good snapshot and exposes the error string —
   "graceful offline" so the UI doesn't blank on transient
   network blips.
5. **`app/api-types.ts`** — wire types mirror of the daemon's
   `serialize.ts`. Hand-mirrored deliberately: the dashboard
   shouldn't import the daemon (lets us split the processes
   later without changing the dashboard).
6. **`app/format.ts`** — `formatDuration` (`42s`/`3m 12s`/`1h 4m`),
   `formatTokens` (thousand-separators), `formatTimestamp`
   (ISO-friendly UTC, never locale-translated).
7. **`app/styles.css`** — dark, dense, monospace numbers. No
   Tailwind dependency. CSS custom properties for theme.

Root `package.json` gained two scripts:

- `pnpm dashboard` → `pnpm --filter @symphony/dashboard dev`
- `pnpm dashboard:build` → production build

## Definition of done

- [x] `curl http://localhost:3000/api/v1/state` returns the wire
      shape (Maps → arrays, Dates → ISO, retries → wall-clock
      due times).
- [x] `404` for unknown paths includes
      `{ error: { code, message } }`.
- [x] `405` for non-GET methods on defined routes.
- [x] `pnpm deps:check` passes; `http/` only imports from
      `types/`, `observability/`.
- [x] Dashboard renders running, retrying, totals, completed
      panels from the live API.
- [x] Dashboard cannot mutate orchestrator state (read-only by
      construction — no mutating endpoints exist).
- [x] Dashboard renders without console errors.
- [x] `pnpm symphony` + `pnpm dashboard` works as a two-terminal
      dev loop.

## Out of scope (deferred)

- **SSE / WebSocket real-time updates.** Polling at 2s is fine for
  v1. Push could land in Plan 11 (observability sidecar).
- **Authentication.** Loopback-only by default; the operator
  can expose externally on their own terms.
- **Per-issue detail page** (`/issue/[identifier]`). Needs a
  daemon-side event ring buffer to be useful (showing only the
  current snapshot would just duplicate the overview row).
- **Cost USD on totals panel.** The daemon currently aggregates
  tokens but not `total_cost_usd`. Small follow-up — needs an
  `agentTotals.totalCostUsd` field and an event-stream
  accumulator.
- **Production deployment.** Plan 09.
- **`POST /api/v1/refresh` endpoint** that was in the original
  Plan 08 draft. Not implemented; not currently needed (polling
  is the only state-progression mechanism).
- **`concurrently`-based `pnpm dev`** that boots both processes.
  Two-terminal pattern is nicer for log readability; revisit
  when we're shipping the deployment-tier `docker compose up`
  workflow in Plan 09+.

## Open questions

- ~~**Dashboard rendering strategy.**~~ Resolved: client-side
  with a single `'use client'` page that polls. RSC didn't earn
  its keep for a real-time view.
- ~~**Should `server.port` live in `WORKFLOW.md` or env?**~~
  Resolved: env. WORKFLOW.md is workflow-level config; ports
  are deployment-level.
- ~~**Fastify vs built-in `http`?**~~ Resolved: built-in. Two
  routes, one dispatcher; framework was overkill.

## Decision log

- **2026-04-29 — User asked for "basic working version" first;
  defer fancier views.** Plan 08 originally had a per-issue
  detail page in scope. Skipped per the user's explicit
  "implement quickly, basic working version" directive. Per-issue
  detail moves to a later plan once a daemon-side event buffer
  exists (otherwise the page is just one row of the overview).

- **2026-04-29 — No Fastify dependency.** The original draft
  planned Fastify. We ended up at two routes plus an `OPTIONS`
  preflight; that's ~50 lines of `node:http` dispatch. Adding
  Fastify would have meant a ~3MB transitive dep tree for zero
  feature benefit. If we add many more routes later, revisit.

- **2026-04-29 — Wire types are hand-mirrored, not imported.**
  Dashboard's `api-types.ts` mirrors `daemon/src/http/serialize.ts`
  by hand instead of importing. Reasons: (a) the dashboard package
  must be loadable without the daemon's runtime deps so deployment
  surface stays minimal, (b) the daemon's tests pin the wire
  shape so drift surfaces in CI, (c) splitting the daemon process
  later (Plan 9+10) becomes a refactor of one package, not two.

- **2026-04-29 — `server.port` belongs in env, not in
  WORKFLOW.md.** Initially put `server: { port }` in the WORKFLOW
  schema with `.passthrough()` accommodation; user pushed back
  ("why is the server port definition in the workflow md?").
  Right answer: WORKFLOW.md must be portable across daemon
  instances. A port number is a deployment decision; it belongs
  next to `LINEAR_API_KEY` in `.env`. Moved to
  `SYMPHONY_HTTP_PORT` (required to enable) +
  `SYMPHONY_HTTP_HOST` (optional, defaults to loopback). The
  schema field was removed entirely — no half-life, no
  back-compat, since the feature was hours old. The general
  principle is filed for future config decisions: anything that
  hard-codes a port / host / absolute path is deployment.

- **2026-04-29 — Co-locating the HTTP server inside the daemon
  process is provisional.** User asked the obvious question:
  "why is the daemon also a server?" The answer for v1 is
  convenience (shared in-memory state, one process to run); the
  answer for prod is they shouldn't be co-located (different
  restart cadences, different blast radius). Plan to split in
  Plan 9+10 when Docker boundaries are introduced — daemon and
  HTTP API become sibling containers. Today's wire-format
  contract makes that a server-only refactor; the dashboard
  doesn't change. Filed for ADR 0010.

- **2026-04-29 — `nextDueAtMs` semantics: monotonic →
  wall-clock projection at the wire boundary.** The orchestrator
  stores retry due-times against a monotonic clock
  (`performance.now`) so retries fire correctly across NTP
  jumps. The dashboard wants a wall-clock countdown. Solution:
  the serializer takes both clocks at snapshot time, computes
  `delta = retry.dueAtMs - monotonicNow`, projects onto
  `wallClockNow + delta`. Best-effort across NTP jumps but
  fine for "fires in 12s" displays.

- **2026-04-29 — Dashboard tab default refresh = 2s.** A pure
  guess; tunable via `useSnapshot(intervalMs)`. Polling is
  cheap on loopback (60 req/min/tab) and the latency feels
  "live" without hammering the daemon's tick. If the daemon
  ever starts to feel snapshot-call-bound, we'd graduate to SSE
  rather than slow the polling down.

- **2026-04-29 — Build output (`.next/`) gets globally ignored
  by ESLint.** Next.js's build artifacts triggered "file not
  in tsconfig project service" parsing errors when the lint
  pass tried to type-check them. Added `**/.next/**` to the
  global ignores alongside `**/dist/**`. Same pattern as the
  scripts override added in Plan 7.

- **2026-04-29 — No `concurrently` for `pnpm dev`.** A unified
  "dev mode" that runs daemon + dashboard from one shell would
  multiplex their logs into one stream — bad for readability
  during agent runs. Two-terminal pattern is the recommended
  workflow until Plan 09's `docker compose up` makes
  multi-process orchestration the norm.
