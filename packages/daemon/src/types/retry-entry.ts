// `RetryEntry` per SPEC §4.1.7. Scheduled retry state for one issue.
//
// `dueAtMs` is a monotonic-clock timestamp (from `performance.now()`)
// rather than wall-clock, because retries must keep firing correctly
// across system clock changes (NTP adjustments, daylight saving).

import type { IssueId, IssueIdentifier } from './ids.js';

export interface RetryEntry {
  readonly issueId: IssueId;
  /**
   * Best-effort human ID for status surfaces and logs. May be the same
   * as the issue's actual identifier; kept separate because the entry
   * may persist briefly after the issue is no longer fetchable.
   */
  readonly identifier: IssueIdentifier;
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
