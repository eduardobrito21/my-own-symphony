// Retry queue: scheduling, backoff math, and timer management.
//
// SPEC §8.4 defines two retry types with different delays:
//
//   - Continuation retry: fixed 1000 ms. Used after a normal worker
//     exit when the issue is still in an active state (the agent
//     might want another turn on the same workspace, Plan 07).
//
//   - Failure-driven retry: exponential backoff —
//     `min(10000 * 2^(attempt - 1), maxRetryBackoffMs)`.
//     Capped at `agent.max_retry_backoff_ms` (default 5 min).
//
// All scheduling goes through `scheduleRetry`, which:
//   - Cancels any existing timer for the same issue (no double-fire)
//   - Builds a `RetryEntry` and stashes it in `state.retryAttempts`
//   - Sets the timer; the firing callback removes the entry from
//     the queue and re-runs eligibility / dispatch
//
// Per spec §4.1.7 we use a monotonic clock for `dueAtMs` so timers
// keep firing correctly across wall-clock changes (NTP, DST).

import type { IssueId, IssueIdentifier, RetryEntry } from '../types/index.js';

import type { TimerSchedule } from './orchestrator.js';
import type { MutableOrchestratorState } from './state.js';

export type RetryDelayKind = 'continuation' | 'failure';

export interface ScheduleRetryArgs {
  readonly state: MutableOrchestratorState;
  readonly issueId: IssueId;
  readonly identifier: IssueIdentifier;
  readonly attempt: number;
  readonly delayKind: RetryDelayKind;
  readonly maxRetryBackoffMs: number;
  readonly schedule: TimerSchedule;
  readonly onFire: (issueId: IssueId) => void;
  readonly error?: string;
  /** Override the monotonic clock for tests (defaults to performance.now). */
  readonly monotonicNow?: () => number;
}

/**
 * Schedule (or re-schedule) a retry for `issueId`. Returns the delay
 * that was applied so callers can log it.
 */
export function scheduleRetry(args: ScheduleRetryArgs): number {
  const {
    state,
    issueId,
    identifier,
    attempt,
    delayKind,
    maxRetryBackoffMs,
    schedule,
    onFire,
    error,
    monotonicNow,
  } = args;

  // Cancel an in-flight retry for this issue if any. Two calls in a
  // row should never produce two pending firings.
  const existing = state.retryAttempts.get(issueId);
  if (existing !== undefined) {
    schedule.clearTimeout(existing.timerHandle);
  }

  const delayMs = computeDelay(delayKind, attempt, maxRetryBackoffMs);
  const now = (monotonicNow ?? performance.now.bind(performance))();

  const handle = schedule.setTimeout(() => {
    onFire(issueId);
  }, delayMs);

  const entry: RetryEntry = {
    issueId,
    identifier,
    attempt,
    dueAtMs: now + delayMs,
    timerHandle: handle,
    error: error ?? null,
  };
  state.retryAttempts.set(issueId, entry);

  return delayMs;
}

/**
 * Cancel and remove a scheduled retry. No-op if there isn't one.
 */
export function cancelRetry(
  state: MutableOrchestratorState,
  issueId: IssueId,
  schedule: TimerSchedule,
): void {
  const existing = state.retryAttempts.get(issueId);
  if (existing === undefined) return;
  schedule.clearTimeout(existing.timerHandle);
  state.retryAttempts.delete(issueId);
}

/**
 * Compute the backoff delay (ms) for a retry.
 *
 * Continuation retries are a fixed 1s short delay (per SPEC §8.4).
 * The fixed delay is intentional — the orchestrator is checking
 * "should I keep working?" not "did something go wrong?"
 *
 * Failure delays grow exponentially, doubling each attempt, capped
 * at `maxRetryBackoffMs`. For attempt = 1 that's 10s; attempt = 2 is
 * 20s; attempt = 6 is 320s (already over the default 300s cap, so
 * stays at 300s from then on).
 */
export function computeDelay(
  kind: RetryDelayKind,
  attempt: number,
  maxRetryBackoffMs: number,
): number {
  if (kind === 'continuation') return 1_000;
  // attempt is 1-based.
  const exponent = Math.max(0, attempt - 1);
  const ideal = 10_000 * Math.pow(2, exponent);
  return Math.min(ideal, maxRetryBackoffMs);
}
