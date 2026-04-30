import { describe, expect, it } from 'vitest';

import {
  IssueId,
  IssueIdentifier,
  ProjectKey,
  type BlockerRef,
  type Issue,
} from '../types/index.js';

import { evaluateEligibility } from './eligibility.js';

const CONFIG = {
  activeStates: ['Todo', 'In Progress'],
  terminalStates: ['Done', 'Cancelled', 'Closed'],
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    projectKey: ProjectKey('default'),
    title: 'A title',
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

function blocker(state: string | null): BlockerRef {
  return {
    id: state === null ? null : IssueId('blocker-id'),
    identifier: state === null ? null : IssueIdentifier('SYMP-99'),
    state,
  };
}

describe('evaluateEligibility', () => {
  describe('state matching', () => {
    it('accepts an issue whose state is in active_states (case-insensitive)', () => {
      expect(evaluateEligibility(makeIssue({ state: 'IN PROGRESS' }), CONFIG).eligible).toBe(true);
      expect(evaluateEligibility(makeIssue({ state: 'todo' }), CONFIG).eligible).toBe(true);
    });

    it('rejects a terminal state with `state_terminal`', () => {
      const result = evaluateEligibility(makeIssue({ state: 'Done' }), CONFIG);
      expect(result).toEqual({ eligible: false, reason: 'state_terminal' });
    });

    it('rejects a state that is neither active nor terminal with `state_not_active`', () => {
      const result = evaluateEligibility(makeIssue({ state: 'Backlog' }), CONFIG);
      expect(result).toEqual({ eligible: false, reason: 'state_not_active' });
    });
  });

  describe('Todo blocker rule (SPEC §8.2)', () => {
    it('skips a Todo with a non-terminal blocker', () => {
      const result = evaluateEligibility(
        makeIssue({ state: 'Todo', blockedBy: [blocker('In Progress')] }),
        CONFIG,
      );
      expect(result).toEqual({ eligible: false, reason: 'todo_with_non_terminal_blocker' });
    });

    it('dispatches a Todo whose blockers are all terminal', () => {
      const result = evaluateEligibility(
        makeIssue({
          state: 'Todo',
          blockedBy: [blocker('Done'), blocker('Cancelled')],
        }),
        CONFIG,
      );
      expect(result.eligible).toBe(true);
    });

    it('treats a blocker with state=null as non-terminal (conservative)', () => {
      const result = evaluateEligibility(
        makeIssue({ state: 'Todo', blockedBy: [blocker(null)] }),
        CONFIG,
      );
      expect(result.eligible).toBe(false);
    });

    it('does NOT apply the blocker rule to non-Todo states', () => {
      const result = evaluateEligibility(
        makeIssue({
          state: 'In Progress',
          blockedBy: [blocker('Todo')], // would fail under Todo rule
        }),
        CONFIG,
      );
      expect(result.eligible).toBe(true);
    });
  });

  describe('required fields', () => {
    it('rejects an issue with empty title via `missing_required_field`', () => {
      const result = evaluateEligibility(makeIssue({ title: '' }), CONFIG);
      expect(result).toEqual({ eligible: false, reason: 'missing_required_field' });
    });
  });
});
