# Plan 02 — Domain model and FakeTracker

- **Status:** Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-28
- **Spec sections:** §4 (Core Domain Model), §11 (Issue Tracker
  Integration Contract)
- **Layers touched:** `types/`, `tracker/`

## Goal

Define the canonical domain model used throughout the daemon, ship a
`Tracker` interface with a `FakeTracker` implementation, and expose
prompt-rendering against that domain. After this plan, the orchestrator
(when written) will have everything it needs to drive a complete tick
against fixture data.

## Out of scope

- Linear adapter. Plan 06.
- Workspace creation. Plan 03.
- The orchestrator itself. Plan 04.

## Steps

1. **Domain types** in `packages/daemon/src/types/`:
   - `IssueId`, `IssueIdentifier`, `WorkspaceKey`, `SessionId` — branded
     string types so we cannot mix them up at compile time.
   - `Issue` (per spec §4.1.1, fields verbatim).
   - `Workspace`, `RunAttempt`, `LiveSession`, `RetryEntry`,
     `OrchestratorState` skeletons.
   - Helper: `sanitizeIdentifier(IssueIdentifier): WorkspaceKey`.
2. **`Tracker` interface** in `packages/daemon/src/tracker/tracker.ts`:
   - `fetchCandidateIssues(): Promise<Issue[]>`.
   - `fetchIssuesByStates(states: string[]): Promise<Issue[]>`.
   - `fetchIssueStatesByIds(ids: IssueId[]): Promise<Issue[]>`.
   - Typed error union for tracker failures.
3. **`FakeTracker`** in `packages/daemon/src/tracker/fake/`:
   - Constructor takes a `FakeTrackerState` (issues, states config).
   - Mutators for tests: `setIssueState`, `addIssue`, `removeIssue`.
   - Honors `tracker.active_states` / `tracker.terminal_states` from
     config, including normalized (lowercase) comparison per spec.
4. **Fixture loader** in `packages/daemon/src/tracker/fake/fixtures/`:
   - Read YAML/JSON fixture file from a configured path.
   - Validated with zod (boundary parsing).
5. **Prompt rendering** in `packages/daemon/src/agent/prompt.ts`
   _(creates the `agent/` layer ahead of Plan 07 since prompt rendering
   is needed by orchestrator dry-runs in Plan 04)_:
   - Render the workflow prompt template with a strict Liquid engine.
   - Inputs: `issue` (object), `attempt` (integer or null).
   - Reject unknown variables and unknown filters.
   - Wrap rendering errors in `TemplateRenderError`.
6. **Tests**:
   - Sanitization: every disallowed character class becomes `_`.
   - Sort order per §8.2: priority asc, created_at oldest, identifier
     lex tiebreaker, nulls last.
   - Blocker rule for `Todo`: ineligible iff any blocker is non-terminal.
   - Active/terminal state matching (case-insensitive).
   - Prompt rendering: success case, unknown-variable case,
     unknown-filter case, retry-attempt case.

## Definition of done

- `pnpm test packages/daemon/src/{types,tracker,agent}` passes.
- Sort and eligibility helpers have golden-table tests covering each
  spec rule explicitly.
- A small fixture file plus the FakeTracker can drive a dry-run script
  that prints the next dispatch decision, given a workflow config.
- `pnpm deps:check` passes; `tracker/` does not import from layers
  above it.

## Open questions

- **Should `agent/prompt.ts` be a separate `prompt/` layer instead of
  living inside `agent/`?** Argument for separate: prompt rendering is
  used by the orchestrator and the agent both. Argument against:
  prompts are conceptually part of agent dispatch. Defer until the
  third caller appears.

## Decision log

- **2026-04-28** — Used branded ID types (`IssueId`, `IssueIdentifier`,
  `WorkspaceKey`, `SessionId`) with same-name constructor functions for
  ergonomics. The `id` / `identifier` distinction in SPEC §4.2 is a
  real source of bugs and branding catches the mistake at compile time
  rather than at the next failing tracker query. Comment in
  `types/ids.ts` explains the pattern for TS beginners.
- **2026-04-28** — Domain types live in `packages/daemon/src/types/`,
  one file per entity (`issue.ts`, `workspace.ts`, `session.ts`,
  `run-attempt.ts`, `retry-entry.ts`, `orchestrator-state.ts`),
  re-exported via a barrel `index.ts`. Single big file would have
  worked but several types reference each other in non-obvious ways —
  separate files make the dependency graph visible.
- **2026-04-28** — `LiveSession` and `OrchestratorState` use
  `agent_*` field names instead of the spec's `codex_*` per ADR 0008.
- **2026-04-28** — Liquid library = `liquidjs`. Configured with
  `strictVariables: true`, `strictFilters: true`, `cache: true`. Cache
  is on so that the same workflow body parsed once is reused across
  many issues per tick.
- **2026-04-28** — Liquid context uses snake_case keys
  (`{{ issue.identifier }}`, `{{ issue.created_at }}`) to match SPEC
  §5.3 examples and upstream Symphony's WORKFLOW.md style. Internal
  domain types are camelCase; we adapt at the prompt boundary in
  `toLiquidContext`.
- **2026-04-28** — Eligibility and sort helpers live in `tracker/`
  even though they're pure functions over `Issue`. Reasoning: the
  full eligibility check (concurrency slots, claimed/running) is a
  Plan 04 concern that lives in `orchestrator/`; Plan 02's helpers
  are the _structural_ subset (state filters, blocker rule) that the
  Linear adapter (Plan 06) can also use to filter at the GraphQL
  layer. Putting them in `tracker/` keeps them accessible to both
  callers without putting policy in `types/`.
- **2026-04-28** — `Tracker` methods take filter args as parameters
  rather than receiving config at construction. Reason: `WORKFLOW.md`
  reload (Plan 05) can change `active_states` between ticks, and we
  want the tracker to use the latest values without rebuilding the
  tracker. The composition root passes a snapshot per call.
- **2026-04-28** — Tracker errors modeled as a discriminated union of
  plain objects (same pattern as `WorkflowError`). Same rationale: the
  orchestrator's reconciliation logic distinguishes "transport failure"
  (retry next tick) from "GraphQL errors" (operator-visible) by
  pattern-matching on `.code`.
- **2026-04-28** — `FakeTracker` ships in production code (not just
  tests) per ADR 0007. Its mutators (`upsertIssue`, `removeIssue`,
  `setIssueState`, `setIssues`) are also production-callable so
  operators can drive it from a fixture-reload hook without rebuilding
  the tracker.
- **2026-04-28** — Fixture YAML uses snake_case keys (`branch_name`,
  `created_at`, `blocked_by`) to match the spec's `Issue` field naming.
  The fixture loader converts to camelCase domain values. Validating
  before constructing branded values means an invalid fixture surfaces
  a typed error rather than a thrown branded-constructor exception.
- **2026-04-28** — One liquidjs surprise: unknown filters
  (`{{ x | foo }}`) are detected at parse time, not render time, even
  though the test plan listed them as "render error". This is strictly
  better behavior — caught earlier — and the test was updated to
  expect `template_parse_error`. SPEC §5.4 / §5.5 don't prescribe
  _when_ the strict-filter check fires; the Plan 02 description was a
  guess.
- **2026-04-28** — Final test count: 119 across 13 files. Coverage
  spans every spec rule named in step 6 (sort order, blocker rule,
  state matching, sanitization, prompt rendering happy/strict paths,
  fixture loading errors, FakeTracker mutators).
- **2026-04-28** — `pnpm deps:check` reports 9 orphan warnings for
  files in `types/`, `tracker/`, and `agent/`. These are accurate:
  Plan 02 builds machinery that Plan 04 (orchestrator) will wire up.
  Warnings are non-fatal (`severity: 'warn'`); they will resolve
  naturally as the orchestrator imports these. We are NOT suppressing
  the rule — the warnings serve as a visible "things to wire up next"
  checklist.
