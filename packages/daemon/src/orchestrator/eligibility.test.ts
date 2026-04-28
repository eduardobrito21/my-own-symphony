import { describe, expect, it } from 'vitest';

import type { AgentConfig, TrackerConfig } from '../config/schema.js';
import { IssueId, IssueIdentifier, type Issue } from '../types/index.js';

import { evaluateRuntimeEligibility } from './eligibility.js';
import { createInitialState, newRunningEntry } from './state.js';
import { composeSessionId } from '../types/index.js';

function tracker(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    endpoint: 'https://api.linear.app/graphql',
    active_states: ['Todo', 'In Progress'],
    terminal_states: ['Done', 'Cancelled'],
    ...overrides,
  };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    max_concurrent_agents: 10,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
    max_concurrent_agents_by_state: {},
    turn_timeout_ms: 3_600_000,
    read_timeout_ms: 5_000,
    stall_timeout_ms: 300_000,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    title: 'title',
    description: null,
    priority: null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('evaluateRuntimeEligibility', () => {
  it('returns eligible for a fresh, dispatchable issue', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    const result = evaluateRuntimeEligibility(makeIssue(), {
      state,
      tracker: tracker(),
      agent: agent(),
    });
    expect(result.eligible).toBe(true);
  });

  it('marks structural failures (state_terminal) without consulting state', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    const result = evaluateRuntimeEligibility(makeIssue({ state: 'Done' }), {
      state,
      tracker: tracker(),
      agent: agent(),
    });
    expect(result).toEqual({ eligible: false, reason: 'state_terminal' });
  });

  it('detects already_running', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    const issue = makeIssue();
    state.running.set(
      issue.id,
      newRunningEntry({
        issue,
        retryAttempt: null,
        placeholderSessionId: composeSessionId('t', 'u'),
        now: new Date(),
      }),
    );
    const result = evaluateRuntimeEligibility(issue, {
      state,
      tracker: tracker(),
      agent: agent(),
    });
    expect(result).toEqual({ eligible: false, reason: 'already_running' });
  });

  it('detects already_claimed even when not running (Plan 05 retry path)', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    const issue = makeIssue();
    state.claimed.add(issue.id);
    const result = evaluateRuntimeEligibility(issue, {
      state,
      tracker: tracker(),
      agent: agent(),
    });
    expect(result).toEqual({ eligible: false, reason: 'already_claimed' });
  });

  it('rejects when global concurrency is full', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 1 });
    state.running.set(
      IssueId('other'),
      newRunningEntry({
        issue: makeIssue({ id: IssueId('other'), identifier: IssueIdentifier('OTHER') }),
        retryAttempt: null,
        placeholderSessionId: composeSessionId('t', 'u'),
        now: new Date(),
      }),
    );
    const result = evaluateRuntimeEligibility(makeIssue(), {
      state,
      tracker: tracker(),
      agent: agent({ max_concurrent_agents: 1 }),
    });
    expect(result).toEqual({ eligible: false, reason: 'no_global_slot' });
  });

  it('rejects when per-state cap is full but global slots remain', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    state.running.set(
      IssueId('other'),
      newRunningEntry({
        issue: makeIssue({
          id: IssueId('other'),
          identifier: IssueIdentifier('OTHER'),
          state: 'Todo',
        }),
        retryAttempt: null,
        placeholderSessionId: composeSessionId('t', 'u'),
        now: new Date(),
      }),
    );
    const result = evaluateRuntimeEligibility(makeIssue({ state: 'Todo' }), {
      state,
      tracker: tracker(),
      agent: agent({
        max_concurrent_agents: 10,
        // Schema lowercases per-state keys.
        max_concurrent_agents_by_state: { todo: 1 },
      }),
    });
    expect(result).toEqual({ eligible: false, reason: 'no_per_state_slot' });
  });

  it('allows a different state to fill its slot independently', () => {
    const state = createInitialState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
    state.running.set(
      IssueId('other'),
      newRunningEntry({
        issue: makeIssue({
          id: IssueId('other'),
          identifier: IssueIdentifier('OTHER'),
          state: 'Todo',
        }),
        retryAttempt: null,
        placeholderSessionId: composeSessionId('t', 'u'),
        now: new Date(),
      }),
    );
    const result = evaluateRuntimeEligibility(makeIssue({ state: 'In Progress' }), {
      state,
      tracker: tracker(),
      agent: agent({
        max_concurrent_agents: 10,
        max_concurrent_agents_by_state: { todo: 1 },
      }),
    });
    expect(result.eligible).toBe(true);
  });
});
