// `Tracker` interface and shared error types.
//
// SPEC §11.1 mandates exactly three operations. We model each as an
// async method that takes only the data it needs. State filters are
// passed in as arguments rather than baked into the tracker at
// construction so the orchestrator can hand off the latest config
// snapshot at each tick (config can change via `WORKFLOW.md` reload —
// Plan 05).
//
// All methods return typed errors via the `TrackerResult` shape rather
// than throwing. The orchestrator's reconciliation logic depends on
// being able to distinguish "transport failed, retry next tick" from
// "GraphQL returned errors, surface to operator" — discriminated
// unions make that explicit.

import type { Issue } from '../types/index.js';
import type { IssueId } from '../types/index.js';

// -----------------------------------------------------------------------
// Error categories — names match SPEC §11.4 verbatim.

export interface UnsupportedTrackerKind {
  readonly code: 'unsupported_tracker_kind';
  readonly message: string;
  readonly kind: string;
}

export interface MissingTrackerApiKey {
  readonly code: 'missing_tracker_api_key';
  readonly message: string;
}

export interface MissingTrackerProjectSlug {
  readonly code: 'missing_tracker_project_slug';
  readonly message: string;
}

export interface LinearApiRequestError {
  readonly code: 'linear_api_request';
  readonly message: string;
  readonly cause: unknown;
}

export interface LinearApiStatusError {
  readonly code: 'linear_api_status';
  readonly message: string;
  readonly status: number;
}

export interface LinearGraphqlErrors {
  readonly code: 'linear_graphql_errors';
  readonly message: string;
  /** Preserved for debugging — agent tools (Plan 07) need access. */
  readonly errors: readonly { readonly message: string }[];
}

export interface LinearUnknownPayload {
  readonly code: 'linear_unknown_payload';
  readonly message: string;
}

export interface LinearMissingEndCursor {
  readonly code: 'linear_missing_end_cursor';
  readonly message: string;
}

export type TrackerError =
  | UnsupportedTrackerKind
  | MissingTrackerApiKey
  | MissingTrackerProjectSlug
  | LinearApiRequestError
  | LinearApiStatusError
  | LinearGraphqlErrors
  | LinearUnknownPayload
  | LinearMissingEndCursor;

export type TrackerResult<T> = { ok: true; value: T } | { ok: false; error: TrackerError };

// -----------------------------------------------------------------------
// The interface itself.

export interface FetchCandidatesArgs {
  /** Lowercased state names to filter to. SPEC §11.1 / §4.2. */
  readonly activeStates: readonly string[];
}

export interface FetchByStatesArgs {
  readonly states: readonly string[];
}

export interface FetchByIdsArgs {
  readonly ids: readonly IssueId[];
}

export interface TransitionIssueStateArgs {
  readonly issueId: IssueId;
  /** Operator-configured target state name (e.g. "In Progress").
   *  Resolved against the issue's team's workflow states with
   *  case-insensitive matching. */
  readonly targetStateName: string;
}

/**
 * Outcome of a state-transition attempt. Three variants:
 *
 *   - `transitioned` — the issue was moved from one state to another.
 *   - `noop`         — the issue was already in the target state;
 *                      no mutation issued.
 *   - `skipped`      — the target state name did not match any state
 *                      in the issue's team; nothing was mutated. The
 *                      caller's responsibility to log + surface the
 *                      operator misconfiguration; the daemon should
 *                      proceed with dispatch regardless.
 */
export type TransitionOutcome =
  | { readonly kind: 'transitioned'; readonly fromStateName: string; readonly toStateName: string }
  | {
      readonly kind: 'noop';
      readonly reason: 'already-in-target-state';
      readonly currentStateName: string;
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'target-state-not-found';
      readonly available: readonly string[];
    };

/**
 * Issue-tracker adapter. SPEC §11.1.
 *
 * Two implementations satisfy this interface:
 *   - `FakeTracker` (Plan 02) — in-memory, used for tests and dev.
 *   - `LinearTracker` (Plan 06) — real Linear GraphQL.
 *
 * The composition root in `index.ts` selects between them based on
 * `tracker.kind` in `WORKFLOW.md`.
 */
export interface Tracker {
  /**
   * Issues that are candidates for dispatch this tick. Returns issues
   * whose state matches one of `activeStates` (case-insensitive per
   * SPEC §4.2). The order is unspecified — sorting happens in
   * `sort.ts`.
   */
  fetchCandidateIssues(args: FetchCandidatesArgs): Promise<TrackerResult<readonly Issue[]>>;

  /**
   * Issues currently in any of the given states. Used at startup for
   * terminal-workspace cleanup (SPEC §8.6).
   */
  fetchIssuesByStates(args: FetchByStatesArgs): Promise<TrackerResult<readonly Issue[]>>;

  /**
   * Refresh the current state of specific issues. Used by tick-time
   * reconciliation (SPEC §8.5). The result preserves only the fields
   * needed for state classification — full bodies/descriptions are
   * not re-fetched.
   */
  fetchIssueStatesByIds(args: FetchByIdsArgs): Promise<TrackerResult<readonly Issue[]>>;

  /**
   * Transition one issue to a target workflow state (Plan 23). Used
   * by the orchestrator to mark issues as "In Progress" at dispatch
   * time so the Linear dashboard reflects in-flight work. Returns a
   * structured outcome — see `TransitionOutcome`. Idempotent: a
   * `kind: 'noop'` is returned (no API mutation issued) when the
   * issue is already in the target state. Resolution of
   * `targetStateName` against the team's workflow states is
   * case-insensitive.
   */
  transitionIssueState(args: TransitionIssueStateArgs): Promise<TrackerResult<TransitionOutcome>>;
}
