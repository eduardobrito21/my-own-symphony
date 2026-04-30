// `RetryEntry` per SPEC §4.1.7. Scheduled retry state for one issue.
//
// `dueAtMs` is a monotonic-clock timestamp (from `performance.now()`)
// rather than wall-clock, because retries must keep firing correctly
// across system clock changes (NTP adjustments, daylight saving).

import type { Issue } from './issue.js';
import type { IssueId, IssueIdentifier, ProjectKey } from './ids.js';

export interface RetryEntry {
  readonly issueId: IssueId;
  /**
   * Best-effort human ID for status surfaces and logs. May be the same
   * as the issue's actual identifier; kept separate because the entry
   * may persist briefly after the issue is no longer fetchable.
   */
  readonly identifier: IssueIdentifier;
  /**
   * Multi-project (Plan 09c): which project this retry belongs to,
   * so `handleRetryFire` knows which tracker to re-query for the
   * issue. The snapshot also uses this to attribute retries to
   * the correct project counter.
   */
  readonly projectKey: ProjectKey;
  /**
   * Snapshot of the issue at the moment the retry was scheduled.
   * Used by `handleRetryFire` to compute project-key-aware
   * snapshots (`projectSnapshots` aggregates `retryAttempts` by
   * `entry.issue.projectKey`).
   *
   * Optional for back-compat with retry-entries created by code
   * paths that don't carry the issue (older callers); when
   * undefined, snapshot attribution falls back to projectKey above.
   */
  readonly issue?: Issue;
  /** 1-based retry attempt counter. */
  readonly attempt: number;
  /** Monotonic clock timestamp (ms). */
  readonly dueAtMs: number;
  /**
   * Runtime-specific timer reference. We model it as `unknown` because
   * different runtimes (Node `setTimeout`, vitest fake timers) return
   * different shapes; the orchestrator only needs to round-trip the
   * value to `clearTimeout`.
   */
  readonly timerHandle: unknown;
  readonly error: string | null;
}
