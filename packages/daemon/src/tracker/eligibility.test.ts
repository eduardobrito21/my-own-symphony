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

  describe('excluded labels (Plan 21 escalation gate)', () => {
    it('rejects an issue carrying any excluded label with `excluded_label`', () => {
      const result = evaluateEligibility(
        // Labels arrive from the Linear normalizer already lowercased.
        makeIssue({ labels: ['priority:high', 'need human help'] }),
        { ...CONFIG, excludedLabels: ['Need Human Help'] },
      );
      expect(result).toEqual({ eligible: false, reason: 'excluded_label' });
    });

    it('matching is case-insensitive on both sides', () => {
      // Belt-and-suspenders: even if the normalizer ever stops
      // lowercasing, or operator config uses mixed case, we still
      // match.
      const upperLabel = evaluateEligibility(makeIssue({ labels: ['NEED HUMAN HELP'] }), {
        ...CONFIG,
        excludedLabels: ['need human help'],
      });
      expect(upperLabel.eligible).toBe(false);
    });

    it('passes when no labels match the excluded list', () => {
      const result = evaluateEligibility(makeIssue({ labels: ['priority:high', 'namespace'] }), {
        ...CONFIG,
        excludedLabels: ['need human help'],
      });
      expect(result.eligible).toBe(true);
    });

    it('passes when the issue has zero labels', () => {
      const result = evaluateEligibility(makeIssue({ labels: [] }), {
        ...CONFIG,
        excludedLabels: ['need human help'],
      });
      expect(result.eligible).toBe(true);
    });

    it('is a no-op when excludedLabels is empty or omitted', () => {
      const omitted = evaluateEligibility(makeIssue({ labels: ['need human help'] }), CONFIG);
      expect(omitted.eligible).toBe(true);
      const empty = evaluateEligibility(makeIssue({ labels: ['need human help'] }), {
        ...CONFIG,
        excludedLabels: [],
      });
      expect(empty.eligible).toBe(true);
    });

    it('label exclusion fires AFTER state checks (terminal beats labels)', () => {
      // An issue in a terminal state with the escalation label
      // should still surface `state_terminal` as the reason —
      // state is the earlier check and the operator's mental
      // model is "terminal first".
      const result = evaluateEligibility(
        makeIssue({ state: 'Done', labels: ['need human help'] }),
        { ...CONFIG, excludedLabels: ['need human help'] },
      );
      expect(result).toEqual({ eligible: false, reason: 'state_terminal' });
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
