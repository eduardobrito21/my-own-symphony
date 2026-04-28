# Plan 06 — Real Linear adapter

- **Status:** Not started
- **Spec sections:** §11 (Issue Tracker Integration Contract — Linear-
  Compatible)
- **Layers touched:** `tracker/`, `config/` (Linear-specific defaults)

## Goal

Implement the production `Tracker` against Linear's GraphQL API, behind
the same interface as `FakeTracker`. After this plan, swapping
`tracker.kind: linear` in `WORKFLOW.md` switches the daemon from fake
to real with no code change anywhere outside `tracker/`.

## Out of scope

- The agent's `linear_graphql` tool — that lives in `agent/` (Plan 07),
  although it reuses this layer's GraphQL client and auth.
- Other trackers. Per ADR 0007 / deviations, Linear is the only real
  tracker we ship.

## Steps

1. **GraphQL client** in
   `packages/daemon/src/tracker/linear/client.ts`:
   - Plain `fetch` against the configured endpoint with the
     `Authorization: <api_key>` header (no `Bearer ` prefix per
     Linear's convention).
   - 30-second network timeout via `AbortSignal.timeout(30_000)`.
   - JSON parse → zod-validated response shape.
   - Typed errors: transport, non-200, GraphQL `errors` present,
     unparseable.
2. **Pagination** in
   `packages/daemon/src/tracker/linear/paginate.ts`:
   - Generic `paginate(query, vars)` over `pageInfo.hasNextPage` /
     `endCursor`.
   - Detect missing `endCursor` as a typed integrity error.
3. **Queries** in
   `packages/daemon/src/tracker/linear/queries/`:
   - `candidateIssuesByProject.graphql.ts` — uses
     `project: { slugId: { eq: $slug } }` and active-state filter.
   - `issueStatesByIds.graphql.ts` — `issues(filter: { id: { in: $ids } })`,
     variable type `[ID!]!`.
   - `issuesByStates.graphql.ts` — for startup terminal cleanup.
4. **Normalization** in
   `packages/daemon/src/tracker/linear/normalize.ts`:
   - Map Linear's response into the `Issue` domain type.
   - Labels lowercased.
   - Blockers from `inverseRelations` where `type === 'blocks'`.
   - Priority coerced to integer or null.
   - ISO-8601 timestamps parsed to `Date`.
5. **`LinearTracker`** in
   `packages/daemon/src/tracker/linear/tracker.ts`:
   - Implements the `Tracker` interface using the helpers above.
6. **Composition root selection**:
   - Update `packages/daemon/src/index.ts` to pick `LinearTracker`
     when `tracker.kind === 'linear'`, else `FakeTracker`.
7. **Tests**:
   - Unit tests for normalization with vendored sample responses.
   - Pagination test that mocks two pages and verifies order.
   - Real integration test (gated by `LINEAR_API_KEY` env var)
     creating a fresh issue, fetching it, deleting it. Skip if env
     var is unset; do not silently pass.

## Definition of done

- `pnpm test packages/daemon/src/tracker/linear` passes (unit tests
  unconditional; integration tests when credentials are present).
- A live test with a real Linear project successfully ticks the
  orchestrator end-to-end against MockAgent.
- `pnpm deps:check` passes.
- All Linear-specific concerns are contained in
  `packages/daemon/src/tracker/linear/` — no spillover into other
  layers.

## Open questions

- **GraphQL client choice.** `graphql-request` is one easy option;
  hand-rolled `fetch` keeps the dependency surface small and the auth
  flow explicit. Lean toward hand-rolled. Revisit if the adapter
  outgrows it.

## Decision log

(empty)
