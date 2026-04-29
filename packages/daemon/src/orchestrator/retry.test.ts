import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier } from '../types/index.js';

import type { TimerSchedule } from './orchestrator.js';
import { cancelRetry, computeDelay, scheduleRetry } from './retry.js';
import { createInitialState } from './state.js';

describe('computeDelay', () => {
  it('returns a fixed 1000 ms for continuation retries regardless of attempt', () => {
    expect(computeDelay('continuation', 1, 300_000)).toBe(1_000);
    expect(computeDelay('continuation', 5, 300_000)).toBe(1_000);
  });

  it('starts failure backoff at 10s for attempt = 1', () => {
    expect(computeDelay('failure', 1, 300_000)).toBe(10_000);
  });

  it('doubles each attempt: 10s, 20s, 40s, 80s, 160s', () => {
    expect(computeDelay('failure', 2, 300_000)).toBe(20_000);
    expect(computeDelay('failure', 3, 300_000)).toBe(40_000);
    expect(computeDelay('failure', 4, 300_000)).toBe(80_000);
    expect(computeDelay('failure', 5, 300_000)).toBe(160_000);
  });

  it('caps at the configured `max_retry_backoff_ms`', () => {
    // 10s * 2^5 = 320s, but cap is 300s.
    expect(computeDelay('failure', 6, 300_000)).toBe(300_000);
    expect(computeDelay('failure', 100, 300_000)).toBe(300_000);
  });

  it('handles a tighter cap (e.g. 30s) correctly', () => {
    expect(computeDelay('failure', 1, 30_000)).toBe(10_000);
    expect(computeDelay('failure', 2, 30_000)).toBe(20_000);
    // Attempt 3 would be 40s ideal — capped at 30s.
    expect(computeDelay('failure', 3, 30_000)).toBe(30_000);
  });
});

describe('scheduleRetry', () => {
  function freshState(): ReturnType<typeof createInitialState> {
    return createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
  }

  function fakeSchedule(): TimerSchedule & { fires: { handle: number; ms: number }[] } {
    let next = 0;
    const fires: { handle: number; ms: number }[] = [];
    return {
      fires,
      setTimeout(_handler, ms) {
        next += 1;
        fires.push({ handle: next, ms });
        return next;
      },
      clearTimeout(handle) {
        const i = fires.findIndex((f) => f.handle === handle);
        if (i !== -1) fires.splice(i, 1);
      },
    };
  }

  it('inserts a RetryEntry into state with the right shape', () => {
    const state = freshState();
    const schedule = fakeSchedule();
    let now = 1_000;
    const delay = scheduleRetry({
      state,
      issueId: IssueId('id-1'),
      identifier: IssueIdentifier('SYMP-1'),
      attempt: 1,
      delayKind: 'continuation',
      maxRetryBackoffMs: 300_000,
      schedule,
      onFire: () => {
        /* test stub */
      },
      monotonicNow: () => now++,
    });
    expect(delay).toBe(1_000);
    const entry = state.retryAttempts.get(IssueId('id-1'));
    expect(entry).toBeDefined();
    expect(entry?.attempt).toBe(1);
    expect(entry?.identifier).toBe('SYMP-1');
    expect(entry?.dueAtMs).toBe(2_000); // now + delay
    expect(state.claimed.has(IssueId('id-1'))).toBe(true);
  });

  it('honors a caller-provided minimum delay', () => {
    const state = freshState();
    const schedule = fakeSchedule();
    const delay = scheduleRetry({
      state,
      issueId: IssueId('id-1'),
      identifier: IssueIdentifier('SYMP-1'),
      attempt: 1,
      delayKind: 'failure',
      maxRetryBackoffMs: 300_000,
      minDelayMs: 60_000,
      schedule,
      onFire: () => {
        /* test stub */
      },
      monotonicNow: () => 0,
    });
    expect(delay).toBe(60_000);
    expect(schedule.fires[0]?.ms).toBe(60_000);
  });

  it('cancels a previous retry for the same issue when re-scheduling', () => {
    const state = freshState();
    const schedule = fakeSchedule();
    scheduleRetry({
      state,
      issueId: IssueId('id-1'),
      identifier: IssueIdentifier('SYMP-1'),
      attempt: 1,
      delayKind: 'continuation',
      maxRetryBackoffMs: 300_000,
      schedule,
      onFire: () => {
        /* test stub */
      },
      monotonicNow: () => 0,
    });
    expect(schedule.fires).toHaveLength(1);
    scheduleRetry({
      state,
      issueId: IssueId('id-1'),
      identifier: IssueIdentifier('SYMP-1'),
      attempt: 2,
      delayKind: 'failure',
      maxRetryBackoffMs: 300_000,
      schedule,
      onFire: () => {
        /* test stub */
      },
      monotonicNow: () => 0,
    });
    // The old timer was cancelled; only the new one remains.
    expect(schedule.fires).toHaveLength(1);
    expect(state.retryAttempts.get(IssueId('id-1'))?.attempt).toBe(2);
  });
});

describe('cancelRetry', () => {
  it('drops the retry entry and clears the timer', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    const fires: number[] = [];
    let next = 0;
    const schedule: TimerSchedule = {
      setTimeout: () => {
        next += 1;
        fires.push(next);
        return next;
      },
      clearTimeout: (handle) => {
        const i = fires.indexOf(handle as number);
        if (i !== -1) fires.splice(i, 1);
      },
    };
    scheduleRetry({
      state,
      issueId: IssueId('id-1'),
      identifier: IssueIdentifier('SYMP-1'),
      attempt: 1,
      delayKind: 'continuation',
      maxRetryBackoffMs: 300_000,
      schedule,
      onFire: () => {
        /* test stub */
      },
      monotonicNow: () => 0,
    });
    expect(state.retryAttempts.size).toBe(1);
    expect(state.claimed.has(IssueId('id-1'))).toBe(true);
    cancelRetry(state, IssueId('id-1'), schedule);
    expect(state.retryAttempts.size).toBe(0);
    expect(state.claimed.has(IssueId('id-1'))).toBe(false);
    expect(fires).toHaveLength(0);
  });

  it('is a no-op when the issue has no pending retry', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    const schedule: TimerSchedule = {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    };
    expect(() => {
      cancelRetry(state, IssueId('does-not-exist'), schedule);
    }).not.toThrow();
  });
});
