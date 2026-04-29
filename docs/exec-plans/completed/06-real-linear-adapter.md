# Plan 06 — Real Linear adapter

- **Status:** ✅ Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-29
- **Spec sections:** §11 (Issue Tracker Integration Contract — Linear-
  Compatible)
- **Layers touched:** `tracker/`, `config/` (Linear-specific defaults),
  `examples/linear/` + `scripts/` (smoke scaffolding)

## Outcome

Real `LinearTracker` shipped, drop-in compatible with `FakeTracker`
behind the same `Tracker` interface. End-to-end smoke against a real
Linear project (`c58e6fc4ca75`, issue `EDU-5`) succeeded after fixing
one schema bug that only surfaced under live API traffic. 233 tests
green; `pnpm deps:check` clean; no Linear-specific concerns leaked
out of `packages/daemon/src/tracker/linear/`.

## What we learned

1. **Schema-drift bugs hide from unit tests.** Our
   `inverseRelations(filter: { type: { eq: "blocks" } })` query
   passed every unit test because the tests mocked the *response*
   shape we expected — but Linear's schema rejects the *request*
   shape, returning 400. Live smoke caught it on the first poll.
   Reinforces the harness-engineering case for real-API smoke
   scripts even when typed schemas + zod validation make you feel
   safe.
2. **Linear's `Authorization` header is the silent killer.** Raw
   token, no `Bearer ` prefix. The first thing to verify when
   debugging a Linear 401.
3. **`[ID!]!` ≠ `[String!]!` in Linear.** Wrong type causes 422,
   not silent fail. Pinned in `IssueStatesByIdsVariables`.
4. **Two write-back paths into Linear, both intentional.**
   Bash hooks (this plan) for lifecycle markers; agent
   `linear_graphql` tool (Plan 07) for narrative comments the
   agent itself authors. Hooks demonstrated end-to-end by posting
   a real comment to EDU-5 from `bash -lc <script>` using two
   GraphQL round-trips parsed with `node -e`.
5. **The `slugId` confusion.** The `slugId` you put in
   `WORKFLOW.md` is the short hex ID (`c58e6fc4ca75`), the same
   token that appears in Linear's URLs. The `id` field is a UUID.
   The list-projects script saves a 5-minute schema dive.
6. **Composition root validates config before construction.**
   Refusing to start when `tracker.api_key` or
   `tracker.project_slug` is missing gives the operator a clear
   error at startup, not a confusing 401/422 at first poll.

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
   - ~~Real integration test (gated by `LINEAR_API_KEY` env var)
     creating a fresh issue, fetching it, deleting it.~~ Deferred
     to Plan 13 (operational readiness). We ran a manual smoke
     instead — see the smoke decision-log entry below.

## Definition of done

- [x] `pnpm test packages/daemon/src/tracker/linear` passes — 233
      tests across 29 files, +28 in `tracker/linear/` (client,
      pagination, normalize, tracker integration).
- [x] A live test with a real Linear project successfully ticks
      the orchestrator end-to-end against MockAgent — smoke against
      project `c58e6fc4ca75`, issue `EDU-5`, 4 MockAgent turns,
      clean SIGINT shutdown. See decision log entry "Live smoke
      against project …".
- [x] `pnpm deps:check` passes.
- [x] All Linear-specific concerns are contained in
      `packages/daemon/src/tracker/linear/` — no spillover into
      other layers. Composition root in `packages/daemon/src/index.ts`
      uses the abstract `Tracker` interface; the
      `tracker.kind === 'linear'` check is the only place it knows
      Linear exists.

## Open questions

- ~~**GraphQL client choice.**~~ Resolved: hand-rolled `fetch` wrapper
  in `client.ts`. ~150 lines, explicit error categories, no extra
  deps.

## Decision log

- **2026-04-28** — Hand-rolled `LinearClient` over `graphql-request`.
  Reason: the four typed error categories (transport / non-200 /
  GraphQL / payload) need to map 1:1 from spec §11.4 codes; a
  library wraps errors in its own taxonomy that we'd have to
  translate. Hand-rolling it is also the more transferable lesson.
- **2026-04-28** — Two issue normalizers: `normalizeFullIssue`
  (every field) and `normalizeMinimalIssue` (id/identifier/state
  only, placeholders for the rest). The minimal version is for
  reconciliation (`fetchIssueStatesByIds`) where the orchestrator
  only inspects `state`; SPEC §17.3 explicitly allows minimal
  Issues here.
- **2026-04-28** — Page size = 50 (spec default). Pagination cap
  = 200 pages = 10,000 issues. Anything beyond that is suspected
  infinite-loop bug; fail with `linear_missing_end_cursor`.
- **2026-04-28** — Linear's `Authorization` header takes the raw
  token (no `Bearer ` prefix). Tested explicitly because the
  Bearer-prefix mistake is the #1 reason a Linear integration
  silently 401s. Test: `client.test.ts` "sends the API key as
  the Authorization header (no Bearer prefix)".
- **2026-04-28** — `IssueStatesByIds` uses GraphQL variable type
  `[ID!]!` (not `[String!]!`) because Linear distinguishes ID and
  String at the schema level. Wrong type causes 422; correct type
  is in SPEC §11.2.
- **2026-04-28** — Composition root gates `tracker.kind=linear`
  on presence of both `tracker.api_key` and `tracker.project_slug`
  before constructing a `LinearTracker`. Operator gets a clear
  error message at startup rather than a confusing 401/422 at
  first poll.
- **2026-04-28** — No automated live integration test in this
  plan. SPEC §17.8 describes "Real Integration Profile" tests that
  create disposable Linear artifacts; we defer those to a separate
  `make e2e` target. Plan 13 (production deployment doc) will
  discuss live integration testing as part of operational
  readiness. We did run a one-off **manual smoke** against a real
  Linear project to validate the integration end-to-end (see the
  smoke entry below) — that is not the same as the automated
  profile and we are not committing the smoke workflow as a test.
- **2026-04-29** — **Schema bug found & fixed during live smoke.**
  Linear's GraphQL schema does NOT allow a `filter` argument on
  `Issue.inverseRelations`. The original implementation tried
  `inverseRelations(filter: { type: { eq: "blocks" } })` and
  every poll returned HTTP 400. Fix: drop the server-side filter,
  add the relation `type` field to the selection set, and narrow
  to `"blocks"` client-side in `normalizeFullIssue`. Other
  inverse-relation types (`duplicate`, `related`) are now
  explicitly ignored. Pinned by a new test
  ("ignores non-blocks inverse relations") so we don't regress.
  This is the kind of bug that schema-only review can't catch —
  only a real round-trip against the live API surfaces it. Useful
  data point for "harness-first" thinking: the unit tests passed
  (we mocked the response shape we expected); the live smoke is
  what caught it. Argues for keeping a manual smoke script
  alongside automated tests.
- **2026-04-29** — **Live smoke against project `c58e6fc4ca75`
  succeeded** with MockAgent. End-to-end flow proven:
    1. workflow loaded with `tracker.kind=linear`
    2. env loading via `node --env-file=.env`
    3. Linear tracker connects (no `linear_api_status`)
    4. startup terminal cleanup ran ("no terminal issues to sweep")
    5. real polling at 5s interval — `tick start` / `tick end
       candidates=N dispatched=N`
    6. real issue `EDU-5` (uuid `d9f36fd3-…`) fetched, paginated,
       zod-validated, normalized
    7. workspace created at `/tmp/symphony-linear-test-workspaces/EDU-5/`
    8. `after_create` hook fired
    9. MockAgent ran 4 turns with full event stream
   10. retry queue cycled correctly (`retry_fired` →
       `retry_released_claim` because already claimed)
   11. SIGINT → clean shutdown with `completed_count=1`
- **2026-04-29** — **Write-back-to-Linear via bash hooks**
  (instead of the agent's `linear_graphql` tool, which arrives
  in Plan 07). Used the `after_create` hook to post a real
  comment to EDU-5 from `bash -lc <script>`: two GraphQL
  round-trips (`issue` lookup by identifier → `commentCreate`
  by UUID), parsed with `node -e` to avoid a `python3` /
  `jq` dependency. `$LINEAR_API_KEY` is inherited from the
  daemon's `--env-file` so the hook didn't need explicit
  config. Comment posted at `80dfcd5d-ad46-4091-bbaf-9dc218ab837d`.
  Lesson: hooks are a real, language-agnostic write-back path
  for **lifecycle markers** ("Symphony picked this up", "agent
  finished turn N"); the agent's `linear_graphql` tool is the
  right path for **narrative comments** the agent itself
  authors. Both layers exist intentionally.
- **2026-04-29** — Follow-up filed for Plan 14 (hook patterns):
  inject `$SYMPHONY_ISSUE_ID`, `$SYMPHONY_ISSUE_IDENTIFIER`,
  `$SYMPHONY_ISSUE_STATE` into the hook env so write-back hooks
  don't need the `basename "$PWD"` trick + a separate Linear
  lookup query. Today the hook only knows the workspace path; a
  real production setup would prefer the IDs to come from the
  daemon directly.
- **2026-04-29** — Final test count: **233** across 29 files
  (+1 from initial 232). The added test pins the new
  client-side `type === 'blocks'` filter behavior. Coverage now:
  client error mapping (4 cases), pagination (5 cases including
  integrity errors), normalization (9 cases — added the
  non-blocks inverse-relations case to the original 8), tracker
  pipeline (8 cases including pagination, schema-drift, error
  propagation, empty-input short-circuits).
- **2026-04-29** — Smoke scaffolding shipped alongside the
  adapter: `examples/linear/WORKFLOW.md` (with the write-back
  hook as a documented example), `examples/linear/README.md`
  (setup walkthrough), `scripts/list-linear-projects.mjs` (a
  tiny standalone fetch script for finding `slugId` values
  without bringing up the daemon). Root `package.json` gained
  a `pnpm symphony` script that wraps
  `node --env-file=.env packages/daemon/dist/index.js`.
