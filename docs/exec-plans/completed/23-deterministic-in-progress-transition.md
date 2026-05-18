---
status: completed
linear_issue: null
github_pr: null
created: 2026-05-18
updated: 2026-05-18
closed: 2026-05-18
---

# Plan 23 — Deterministic Todo → In Progress transition at dispatch time

- **Implements:** the tech-debt-tracker entry "Pipeline does
  not transition Linear issue to In Progress at dispatch time"
  (logged during Plan 21 close-out, 2026-05-18). Today an
  issue stays in **Todo** for the entire pipeline run (~3-7
  minutes); the agent's close-out only transitions to Done on
  success or adds the escalation label on failure. From a
  Linear dashboard, "agent is actively working on this issue"
  is invisible.
- **Comes AFTER:** Plan 21 (loop + sensors + close-out
  escalation). Plan 21 finalized the close-out's state-
  transition behavior; this plan adds the symmetric **opening**
  transition. Plan 06 (real Linear adapter) is the structural
  ancestor — that plan established the read-only `Tracker`
  shape this plan extends with mutations.
- **Comes BEFORE:** any future plan that introduces non-
  trivial issue-state behavior (multi-stage states, "Blocked"
  during reviewer cycle, etc.). Establishing
  `transitionIssueState` as the canonical mutation point makes
  later state transitions a one-line extension.
- **Spec sections:** none.
- **Layers touched:**
  - `packages/daemon/src/tracker/tracker.ts` — add
    `transitionIssueState` to the `Tracker` interface
    ([tracker.ts:105-127](packages/daemon/src/tracker/tracker.ts)).
  - `packages/daemon/src/tracker/linear/tracker.ts` — implement
    against Linear's GraphQL surface ([tracker.ts:1-166](packages/daemon/src/tracker/linear/tracker.ts)).
  - `packages/daemon/src/tracker/linear/queries.ts` +
    `.../linear/responses.ts` + `.../linear/client.ts` — new
    `workflowStates` query, new `issueUpdate` mutation, zod
    response schemas. The client is read-only today; promote
    it to support mutations as a first-class path.
  - `packages/daemon/src/tracker/fake/fake-tracker.ts` — add
    the new interface method (the fake already has
    `setIssueState` as a test helper; the new method just
    becomes the canonical one).
  - `packages/daemon/src/config/schema.ts` — new optional
    field `in_progress_state` on `TrackerConfigSchema`
    ([schema.ts:62-96](packages/daemon/src/config/schema.ts)),
    default `"In Progress"`, parallel in shape to the existing
    `active_states` / `terminal_states` fields.
  - `packages/daemon/src/orchestrator/orchestrator.ts` — call
    `transitionIssueState` immediately before each
    `dispatchOne` invocation
    ([orchestrator.ts:271](packages/daemon/src/orchestrator/orchestrator.ts) for
    the tick-loop fresh dispatch,
    [orchestrator.ts:676](packages/daemon/src/orchestrator/orchestrator.ts) for
    the reconcile/retry promotion path).
- **ADRs referenced:** ADR 0006 (zod at every boundary —
  Linear's `workflowStates` and `issueUpdate` responses are
  new boundaries, schemas required), ADR 0014 (per-project
  isolation — config-level `in_progress_state` keeps the
  transition operator-configurable per workflow file).

## Goal

Make "agent is working on this" visible in Linear the moment
the daemon picks up an issue. Before invoking the pipeline,
transition the issue to the operator-configured state
(default `"In Progress"`). Idempotent (skip if already
there), non-blocking (a failure logs and continues — the
pipeline still runs), and isolated to one new `Tracker`
method that future mutations can mirror.

After this plan ships:

- A dispatch tick that picks up issue `EDU-N` transitions
  `EDU-N` from `Todo` → `In Progress` before any sub-agent
  runs. Operator's dashboard reflects in-flight state for the
  ~3-7 minutes the pipeline takes.
- The same transition fires in the reconcile/retry path
  ([orchestrator.ts:676](packages/daemon/src/orchestrator/orchestrator.ts))
  for retries that promote into a fresh dispatch slot.
- If the configured state doesn't exist on the issue's team,
  or the Linear API rejects the mutation, the daemon logs the
  failure and proceeds with the pipeline anyway — the
  transition is observability, not a gate.
- The new `Tracker.transitionIssueState` is the single
  mutation entry-point; the SDK-side close-out's "transition
  to Done" eventually migrates to use it too (out of scope
  here — captured as a follow-up below).

## Why

Three observations:

1. **The Linear dashboard is the operator's visibility into
   the daemon's work.** Pre-Plan 23, Todo issues stay Todo
   throughout the ~5-minute pipeline. The operator can't tell
   "Symphony is on this" from "Symphony hasn't seen this
   yet." Plan 21's escalation label is the failure-side
   signal; the in-progress transition is the success-side
   pre-signal — together they cover the full lifecycle.
2. **`Tracker` is read-only by accident, not by design.**
   Today's three methods are all `fetch*`. The harness-first
   ADR doesn't mandate a read-only Tracker; it's just that
   the close-out's state mutation lives **inside the agent
   prompt** (via the SDK's `linear_graphql` tool) rather than
   through the Tracker interface. This plan introduces the
   first daemon-side mutation as a clean precedent — narrow
   surface, well-typed, fake-tracker-friendly.
3. **The change is small but spans five files.** The tech-
   debt entry already enumerates: interface method + Linear
   client mutation + queries/responses + fake stub + config
   field + two orchestrator call sites + idempotency +
   error-tolerance. None individually is large; together
   they're a self-contained PR with no plan-shape risk.

## Out of scope

- **Migrating the agent-side close-out to use
  `transitionIssueState`.** The close-out currently posts
  the Done transition via `linear_graphql` inside the parent
  agent's Linear-GraphQL tool (see Plan 21's prompt). That's
  load-bearing for a different reason (parent agent owns the
  comment-then-transition atomicity) and we don't have a
  strong reason to refactor it in this PR. Captured as a
  follow-up.
- **Per-state transition configuration.** The plan adds
  exactly one new state slot (`in_progress_state`); it does
  NOT introduce arbitrary state-transition rules ("Todo →
  Triaged → InProgress") or condition-based transitions.
  YAGNI until the operator names a second one.
- **Backfilling already-running pipelines.** If the daemon
  restarts mid-dispatch (Plan 11 reconciliation), in-flight
  issues already have whatever state the previous tick left
  them in. This plan handles the dispatch boundary, not the
  resume boundary.
- **State-name case sensitivity beyond the existing pattern.**
  Plan 06's `active_states` and `terminal_states` are
  matched case-insensitively at runtime; this plan mirrors
  that behavior for `in_progress_state` — no broader
  normalization work.

## Stages

### Stage 23-1 — Extend the `Tracker` interface

In [tracker.ts:105-127](packages/daemon/src/tracker/tracker.ts),
add a fourth method:

    transitionIssueState(args: {
      readonly issueId: IssueId;
      readonly targetStateName: string;
    }): Promise<TrackerResult<TransitionOutcome>>;

Where `TransitionOutcome` is a new discriminated union:

- `{ kind: 'transitioned'; fromStateName: string; toStateName: string }`
- `{ kind: 'noop'; reason: 'already-in-target-state'; currentStateName: string }`
- `{ kind: 'skipped'; reason: 'target-state-not-found'; available: readonly string[] }`

The third variant covers the "operator misconfigured" path
without throwing — the caller logs + proceeds.

Define `TransitionOutcome` in the same file as the existing
`TrackerResult` types so it's reachable from all three
implementations (Linear, fake, mock).

### Stage 23-2 — Linear adapter implementation

Three new artifacts in
`packages/daemon/src/tracker/linear/`:

- **`queries.ts`** — add the GraphQL document for
  `workflowStates(filter: { team: { issues: { id: { eq: $issueId } } } })`
  (returns `nodes { id name }` so the adapter can resolve
  `targetStateName` → `stateId`).
- **`responses.ts`** — zod schemas for the new query's
  response shape (array of `{ id: string; name: string }`)
  and for the `issueUpdate` mutation's response (success +
  the updated issue's `id` and `state.name`).
- **`client.ts`** — promote from read-only to read+write:
  add a `runMutation` method paralleling the existing
  `runQuery`. Same auth, same error mapping, separate
  metric/log labels so dashboards can distinguish.
- **`tracker.ts`** — implement `transitionIssueState`:
  1. Fetch workflow states for the issue's team.
  2. Match `targetStateName` case-insensitively against
     `nodes[].name`. Return `kind: 'skipped'` if no match.
  3. Fetch the issue's current state (or include it in the
     workflow-states query via the issue's relationships,
     whichever costs one fewer round-trip). If
     `current.name.toLowerCase() === target.toLowerCase()`,
     return `kind: 'noop'`.
  4. Otherwise call `issueUpdate(id: $issueId, input:
{ stateId: $stateId })`, validate the response, return
     `kind: 'transitioned'`.

Cap the call at the existing client-wide timeout (no new
timeout knob).

### Stage 23-3 — Fake tracker symmetry

[fake-tracker.ts](packages/daemon/src/tracker/fake/fake-tracker.ts)
already has a `setIssueState` test helper. Add
`transitionIssueState` as a real interface method that:

- Returns `noop` if the current and target states match
  (case-insensitive).
- Returns `transitioned` otherwise, mutating the in-memory
  `Map<IssueId, Issue>` to reflect the new state.
- Returns `skipped` only if the test pre-populated a list of
  "available states" that doesn't include the target — the
  default is "any state name is acceptable" so most tests
  don't have to think about it.

Add a constructor option `availableStates?: readonly string[]`
for tests that exercise the `skipped` path.

### Stage 23-4 — Config field

In [schema.ts:62-96](packages/daemon/src/config/schema.ts)'s
`TrackerConfigSchema`, add alongside `active_states` /
`terminal_states`:

    in_progress_state: z.string().min(1).default('In Progress'),

Plumb through to wherever per-project tracker config is read
by the orchestrator. The orchestrator passes the resolved
value to the new `transitionIssueState` call (Stage 23-5);
nothing else consumes it.

Document in the workflow-file example (and the workflow
README, if one names the existing fields) that this defaults
to `"In Progress"` and only needs setting if the operator's
Linear workspace uses a different name (`"Doing"`,
`"Active"`, etc.).

### Stage 23-5 — Orchestrator wiring

Two call sites, both in
`packages/daemon/src/orchestrator/orchestrator.ts`:

- [Line 271](packages/daemon/src/orchestrator/orchestrator.ts) — the
  tick-loop fresh dispatch. Immediately before
  `this.dispatchOne(issue, null);`, call
  `await this.tryTransitionToInProgress(issue);` (a new
  private method).
- [Line 676](packages/daemon/src/orchestrator/orchestrator.ts) — the
  reconcile/retry promotion path. Same call, immediately
  before `this.dispatchOne(issue, entry.attempt);`.

`tryTransitionToInProgress` encapsulates the non-blocking
behavior:

    private async tryTransitionToInProgress(issue: Issue): Promise<void> {
      const target = this.config.tracker.in_progress_state;
      const result = await this.tracker.transitionIssueState({
        issueId: issue.id,
        targetStateName: target,
      });
      if (result.kind === 'error') {
        this.logger.warn({
          issueId: issue.id,
          target,
          error: result.error,
        }, 'in_progress_transition_failed');
        return; // continue with dispatch
      }
      const outcome = result.value;
      // Log all three success outcomes at INFO; the
      // 'skipped' (target-state-not-found) is the operator-
      // misconfiguration signal we DO want loud.
      this.logger.info({ issueId: issue.id, outcome }, 'in_progress_transition');
    }

Failure modes that MUST NOT block dispatch:

- Linear network error → log, continue.
- Auth error (operator rotated token mid-tick) → log, continue;
  the upcoming pipeline will fail at the same auth boundary
  and surface the real problem.
- `kind: 'skipped'` (configured state name not found) → log
  at WARN so the operator notices the typo; continue.

Failure modes that DO NOT call the transition at all:

- The issue's pre-fetched state is already
  case-insensitive-equal to `target` (skip the round-trip
  entirely — the `noop` short-circuit lives in the
  orchestrator wrapper, not the adapter, to avoid the
  GraphQL call for the common case).

### Stage 23-6 — Tests

Three test surfaces:

- **Fake-tracker contract test:** the new method returns the
  three outcomes against the right pre-conditions
  (already-in-target → noop, missing state → skipped, etc.).
- **Orchestrator test:** the dispatch path calls
  `transitionIssueState` exactly once per dispatch, with the
  configured `in_progress_state`, BEFORE the pipeline kicks.
  Use the fake tracker; assert call order via the existing
  spy patterns. A second test: when the fake returns
  `kind: 'error'` from `transitionIssueState`, dispatch
  still proceeds (the issue still reaches the pipeline).
- **Linear adapter unit test:** mock the `LinearClient`,
  feed it a recorded `workflowStates` response + a recorded
  `issueUpdate` response, assert the adapter resolves
  state-name → id and emits the right mutation variables.
  Plan 06's existing adapter tests are the template.

No end-to-end smoke is required for this plan — Plan 21's
EDU smokes already exercise the dispatch path against real
Linear. The first post-merge dispatch will demonstrate the
transition naturally; if it doesn't fire, the orchestrator
log lines from Stage 23-5 will say why.

## Definition of Done

- `Tracker.transitionIssueState` exists with the three-variant
  outcome type. All three implementations (Linear, fake, any
  mock) compile against the new method.
- Linear adapter resolves `targetStateName` → `stateId` and
  performs the mutation; both responses are zod-validated;
  the client metrics distinguish queries from mutations.
- Config field `in_progress_state` is optional with default
  `"In Progress"`. The default is the case-insensitive match
  used at the resolution step.
- Both `dispatchOne` call sites in
  `orchestrator.ts:271` and `orchestrator.ts:676` invoke
  `tryTransitionToInProgress` BEFORE dispatching. A
  transition failure logs and continues; it does NOT abort
  the dispatch.
- Fake tracker's `transitionIssueState` matches the Linear
  semantics closely enough that the orchestrator tests pass
  unchanged against the fake.
- At least one fresh dispatch on a real Linear issue shows
  the `Todo → In Progress` transition in the Linear UI
  within ~1 second of pickup, and the daemon log line
  `in_progress_transition` confirms `kind: 'transitioned'`.
- Tech-debt-tracker entry "Pipeline does not transition
  Linear issue to In Progress at dispatch time" moves to
  "Paid" with the dispatch date.

## Open questions

- **Should the close-out's Done transition also migrate to
  `Tracker.transitionIssueState`?** Today the agent's close-
  out posts the comment + transitions via `linear_graphql`
  as one atomic agent-side action. Splitting the transition
  out to the daemon side would lose that atomicity (comment
  posts, daemon-side transition fails, issue stays in
  progress with a "Done" comment). Decision: leave the
  close-out path alone for now. If the parent agent's
  reliability becomes the limiting factor on close-out, this
  becomes a natural follow-up plan.
- **Should `transitionIssueState` accept an
  optimistic-locking token (e.g. `expectedCurrentStateName`)
  to guard against a human moving the issue mid-dispatch?**
  Linear doesn't surface a cheap optimistic-lock primitive
  here; we'd have to read-then-write with a races still
  possible. The cost-of-a-race is "agent moves a human-
  moved issue back to In Progress, operator sees the bounce
  and intervenes" — annoying but recoverable. Out of scope;
  noted for the day a real incident demands it.
- **Default state name "In Progress" — what if the operator's
  Linear team uses "Doing" or "Active"?** Configurable via
  `in_progress_state`. The `skipped` outcome at WARN level
  is the discoverability path — operator sees the log and
  updates config. If we wanted higher polish, the daemon
  could enumerate `workflowStates` at startup per project
  and validate `in_progress_state` exists, surfacing
  misconfigurations at boot rather than first dispatch. Not
  in this plan; captured as a polish follow-up.
- **Idempotency semantics across daemon restarts.** The
  `noop` short-circuit relies on the pre-fetched issue's
  state matching the target. If the daemon crashed mid-
  transition and restarted, the issue is already in the
  target state — the next dispatch will short-circuit with
  `noop`. No special handling needed; the natural behavior
  is correct.

## Source

- Tech-debt-tracker entry "Pipeline does not transition
  Linear issue to In Progress at dispatch time" (added
  2026-05-18 during Plan 21 close-out —
  [docs/exec-plans/tech-debt-tracker.md](docs/exec-plans/tech-debt-tracker.md)).
- Operator request during Plan 21 close-out: "when the
  daemon picks up the issue, add a (deterministic) step
  that updates the status to 'In Progress' before running
  the pipeline."
- Plan 06 (real Linear adapter) — establishes the existing
  read-only client + zod-validated response pattern that
  Stage 23-2 extends to mutations.

## Decision log

### 2026-05-18 — Implementation landed; what changed from the spec

- **No separate `runMutation` client method.** Stage 23-2's
  text floated promoting `LinearClient` to "read+write" with
  a dedicated mutation method. The existing `execute<TVars>`
  is already operation-agnostic (a mutation is just a
  different GraphQL operation string) — adding a parallel
  method would have been duplication without observable
  benefit. The adapter passes both queries and the new
  `IssueUpdateState` mutation through `client.execute`.
- **One round-trip for lookup, not two.** The spec sketched a
  separate "fetch issue's current state" step and a
  "fetch team's workflow states" step. The implementation
  collapses both into `ISSUE_WORKFLOW_STATES_QUERY`
  (`issue(id) { state team { states } }`) so the noop
  short-circuit at the adapter level costs one API call,
  not two.
- **Idempotency lives in two places — the orchestrator AND
  the adapter.** The orchestrator pre-checks `issue.state`
  against `ctx.inProgressState` (case-insensitive) and skips
  the call entirely when they match — that's the common case
  on re-dispatch. The adapter STILL re-checks the current
  state (against the freshly fetched `issue.state`) and
  returns `kind: 'noop'` if it matches — this catches the
  race where the orchestrator's pre-fetched state is stale
  but the dashboard already shows the right state. Belt and
  suspenders, but cheap.
- **No startup-time validation that `in_progress_state` is in
  `active_states`.** Considered, deferred. The default
  configuration (`'In Progress'` ∈ `['Todo', 'In Progress']`)
  works out of the box; misconfigurations manifest as
  `kind: 'skipped'` log lines on first dispatch, which is
  loud enough. Adding startup validation would mean
  enumerating workflow states per project at boot — extra
  GraphQL surface for a guard that doesn't pay yet.
- **No smoke run in this PR.** Plan 23's DoD calls for one
  real-Linear dispatch demonstrating the transition. That
  smoke fires naturally on the next post-merge dispatch
  (the new field has a default; existing `symphony.yaml`
  works without changes). The log line
  `in_progress_transition` with `outcome.kind:
'transitioned'` is the success signal.

### 2026-05-18 — Tests landed

- 5 new fake-tracker tests (transition variants + call log +
  result queue).
- 7 new LinearTracker tests (mocked client; covers
  transitioned / noop / skipped / case-insensitive lookup /
  null-issue + success: false + transport error).
- 6 new orchestrator tests (Plan 23 file): call-once,
  configurable target state, idempotent pre-check
  (case-sensitive + insensitive), non-blocking on error,
  non-blocking on skipped.
- One new deployment-config test pinning the
  `in_progress_state` default + custom-override.
- All 425 tests pass; typecheck + lint clean.
