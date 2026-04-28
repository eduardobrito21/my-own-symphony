# Plan 02 — Domain model and FakeTracker

- **Status:** Not started
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

(empty)
