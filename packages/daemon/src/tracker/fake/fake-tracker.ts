// In-memory `Tracker` implementation for development and tests.
//
// `FakeTracker` is constructed with a list of `Issue`s and exposes
// mutators (`setIssueState`, `addIssue`, `removeIssue`) that tests
// use to simulate tracker state changes between ticks. Per ADR 0007
// it ships in production code (not just tests) and is the default
// when `tracker.kind !== 'linear'`.
//
// All methods return synchronously-resolved promises — the interface
// is async to match Linear's network-bound shape, but the fake never
// blocks. Tests can `await tracker.fetchCandidateIssues(...)` without
// timing concerns.

import type {
  FetchByIdsArgs,
  FetchByStatesArgs,
  FetchCandidatesArgs,
  Tracker,
  TrackerResult,
  TransitionIssueStateArgs,
  TransitionOutcome,
} from '../tracker.js';
import type { Issue, IssueId } from '../../types/index.js';
import { isStateAmong } from '../state-matching.js';

export interface FakeTrackerOptions {
  /**
   * Available workflow state names (used to model the
   * `kind: 'skipped'` outcome of `transitionIssueState` when the
   * target name doesn't exist). When `undefined`, the fake accepts
   * any state name as valid — tests that don't exercise the
   * misconfiguration path don't have to think about it.
   */
  readonly availableStates?: readonly string[];
}

export class FakeTracker implements Tracker {
  private issues: Map<IssueId, Issue>;
  private readonly availableStates: readonly string[] | null;
  /** Call log for `transitionIssueState`, in invocation order. Tests
   *  use it to assert "transition was called once before dispatch". */
  public readonly transitionCalls: TransitionIssueStateArgs[] = [];
  /**
   * If set, the next call to `transitionIssueState` returns this
   * `TrackerResult` instead of running the normal logic. Test hook
   * for exercising the orchestrator's non-blocking error path. Reset
   * to `null` after consumption.
   */
  private nextTransitionResult: TrackerResult<TransitionOutcome> | null = null;

  /**
   * Construct from an initial list. The list is shallow-copied; future
   * mutations to the original array do not affect the tracker.
   */
  constructor(initialIssues: readonly Issue[] = [], options: FakeTrackerOptions = {}) {
    this.issues = new Map(initialIssues.map((issue) => [issue.id, issue]));
    this.availableStates = options.availableStates ?? null;
  }

  // ---- Tracker interface methods --------------------------------------

  fetchCandidateIssues(args: FetchCandidatesArgs): Promise<TrackerResult<readonly Issue[]>> {
    const matches = [...this.issues.values()].filter((issue) =>
      isStateAmong(issue.state, args.activeStates),
    );
    return Promise.resolve({ ok: true, value: matches });
  }

  fetchIssuesByStates(args: FetchByStatesArgs): Promise<TrackerResult<readonly Issue[]>> {
    if (args.states.length === 0) {
      // SPEC §17.3: empty `fetch_issues_by_states([])` returns empty
      // without an API call. We mirror the contract.
      return Promise.resolve({ ok: true, value: [] });
    }
    const matches = [...this.issues.values()].filter((issue) =>
      isStateAmong(issue.state, args.states),
    );
    return Promise.resolve({ ok: true, value: matches });
  }

  fetchIssueStatesByIds(args: FetchByIdsArgs): Promise<TrackerResult<readonly Issue[]>> {
    const matches: Issue[] = [];
    for (const id of args.ids) {
      const issue = this.issues.get(id);
      if (issue !== undefined) matches.push(issue);
    }
    return Promise.resolve({ ok: true, value: matches });
  }

  transitionIssueState(args: TransitionIssueStateArgs): Promise<TrackerResult<TransitionOutcome>> {
    this.transitionCalls.push(args);

    if (this.nextTransitionResult !== null) {
      const queued = this.nextTransitionResult;
      this.nextTransitionResult = null;
      return Promise.resolve(queued);
    }

    const targetLower = args.targetStateName.toLowerCase();

    if (
      this.availableStates !== null &&
      !this.availableStates.some((s) => s.toLowerCase() === targetLower)
    ) {
      return Promise.resolve({
        ok: true,
        value: {
          kind: 'skipped',
          reason: 'target-state-not-found',
          available: this.availableStates,
        },
      });
    }

    const existing = this.issues.get(args.issueId);
    if (existing === undefined) {
      // Mirror Linear's behavior: an unknown issue id surfaces as a
      // typed payload error. Orchestrator path treats this as
      // non-fatal and proceeds.
      return Promise.resolve({
        ok: false,
        error: {
          code: 'linear_unknown_payload',
          message: `FakeTracker.transitionIssueState: unknown issue id ${String(args.issueId)}`,
        },
      });
    }

    const currentStateName = existing.state;
    if (currentStateName.toLowerCase() === targetLower) {
      return Promise.resolve({
        ok: true,
        value: {
          kind: 'noop',
          reason: 'already-in-target-state',
          currentStateName,
        },
      });
    }

    // Resolve the target's canonical casing if availableStates was
    // provided; otherwise pass through the operator-supplied casing.
    const canonical =
      this.availableStates?.find((s) => s.toLowerCase() === targetLower) ?? args.targetStateName;
    this.issues.set(args.issueId, { ...existing, state: canonical });
    return Promise.resolve({
      ok: true,
      value: {
        kind: 'transitioned',
        fromStateName: currentStateName,
        toStateName: canonical,
      },
    });
  }

  // ---- Test mutators --------------------------------------------------

  /**
   * Replace the entire issue set. Useful in tests where you want to
   * jump from one fixture to another.
   */
  setIssues(issues: readonly Issue[]): void {
    this.issues = new Map(issues.map((issue) => [issue.id, issue]));
  }

  /**
   * Add or replace one issue.
   */
  upsertIssue(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  /**
   * Remove the issue with the given ID, if present.
   */
  removeIssue(id: IssueId): void {
    this.issues.delete(id);
  }

  /**
   * Mutate the state of one issue, leaving all other fields intact.
   * Returns `true` if the issue was found.
   */
  setIssueState(id: IssueId, newState: string): boolean {
    const existing = this.issues.get(id);
    if (existing === undefined) return false;
    this.issues.set(id, { ...existing, state: newState });
    return true;
  }

  /**
   * Read the issue with the given ID. Used in tests to verify that
   * mutators landed.
   */
  getIssue(id: IssueId): Issue | undefined {
    return this.issues.get(id);
  }

  /**
   * Queue a specific `TrackerResult` for the next
   * `transitionIssueState` call. Used by orchestrator tests to
   * exercise the non-blocking error path without setting up a real
   * misconfiguration.
   */
  queueTransitionResult(result: TrackerResult<TransitionOutcome>): void {
    this.nextTransitionResult = result;
  }
}
