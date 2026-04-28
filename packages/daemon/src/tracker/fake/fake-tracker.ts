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
} from '../tracker.js';
import type { Issue, IssueId } from '../../types/index.js';
import { isStateAmong } from '../state-matching.js';

export class FakeTracker implements Tracker {
  private issues: Map<IssueId, Issue>;

  /**
   * Construct from an initial list. The list is shallow-copied; future
   * mutations to the original array do not affect the tracker.
   */
  constructor(initialIssues: readonly Issue[] = []) {
    this.issues = new Map(initialIssues.map((issue) => [issue.id, issue]));
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
}
