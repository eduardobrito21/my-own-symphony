// `RunAttempt` per SPEC §4.1.5. One execution attempt for one issue.
//
// The attempt counter is `null` for the first run and a positive
// integer for retries / continuations. The orchestrator (Plan 04) uses
// this value when computing exponential backoff.

import type { IssueId, IssueIdentifier } from './ids.js';

/**
 * Phases a run attempt transitions through (SPEC §7.2).
 *
 * Modeled as a string-literal union so `switch` exhaustiveness checks
 * catch missing cases at compile time.
 */
export type RunAttemptStatus =
  | 'preparing_workspace'
  | 'building_prompt'
  | 'launching_agent_process'
  | 'initializing_session'
  | 'streaming_turn'
  | 'finishing'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'stalled'
  | 'canceled_by_reconciliation';

export interface RunAttempt {
  readonly issueId: IssueId;
  readonly issueIdentifier: IssueIdentifier;
  /**
   * `null` on the first run, `>= 1` on retries / continuations.
   * SPEC §4.1.5.
   */
  readonly attempt: number | null;
  readonly workspacePath: string;
  readonly startedAt: Date;
  readonly status: RunAttemptStatus;
  readonly error?: string;
}
