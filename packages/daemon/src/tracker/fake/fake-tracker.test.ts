import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../../types/index.js';

import { FakeTracker } from './fake-tracker.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    projectKey: ProjectKey('default'),
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

describe('FakeTracker', () => {
  describe('fetchCandidateIssues', () => {
    it('returns issues whose state matches active_states (case-insensitive)', async () => {
      const tracker = new FakeTracker([
        makeIssue({ id: IssueId('a'), state: 'Todo' }),
        makeIssue({ id: IssueId('b'), state: 'IN PROGRESS' }),
        makeIssue({ id: IssueId('c'), state: 'Done' }),
      ]);
      const result = await tracker.fetchCandidateIssues({
        activeStates: ['todo', 'in progress'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id).sort()).toEqual(['a', 'b']);
      }
    });

    it('returns an empty list when no issues match', async () => {
      const tracker = new FakeTracker([makeIssue({ state: 'Done' })]);
      const result = await tracker.fetchCandidateIssues({ activeStates: ['Todo'] });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });
  });

  describe('fetchIssuesByStates', () => {
    it('returns empty without inspecting issues when called with []', async () => {
      const tracker = new FakeTracker([makeIssue({ state: 'Done' })]);
      const result = await tracker.fetchIssuesByStates({ states: [] });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });

    it('returns issues matching any of the given states', async () => {
      const tracker = new FakeTracker([
        makeIssue({ id: IssueId('a'), state: 'Done' }),
        makeIssue({ id: IssueId('b'), state: 'Cancelled' }),
        makeIssue({ id: IssueId('c'), state: 'Todo' }),
      ]);
      const result = await tracker.fetchIssuesByStates({ states: ['Done', 'Cancelled'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id).sort()).toEqual(['a', 'b']);
      }
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('returns issues for known IDs and skips unknown ones (no error)', async () => {
      const tracker = new FakeTracker([
        makeIssue({ id: IssueId('a') }),
        makeIssue({ id: IssueId('b') }),
      ]);
      const result = await tracker.fetchIssueStatesByIds({
        ids: [IssueId('a'), IssueId('does-not-exist')],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id)).toEqual(['a']);
      }
    });
  });

  describe('transitionIssueState (Plan 23)', () => {
    it('transitions an issue and reports the from/to state names', async () => {
      const tracker = new FakeTracker([makeIssue({ id: IssueId('a'), state: 'Todo' })]);
      const result = await tracker.transitionIssueState({
        issueId: IssueId('a'),
        targetStateName: 'In Progress',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          kind: 'transitioned',
          fromStateName: 'Todo',
          toStateName: 'In Progress',
        });
      }
      expect(tracker.getIssue(IssueId('a'))?.state).toBe('In Progress');
    });

    it('returns noop without mutating when already in the target state (case-insensitive)', async () => {
      const tracker = new FakeTracker([makeIssue({ id: IssueId('a'), state: 'IN PROGRESS' })]);
      const result = await tracker.transitionIssueState({
        issueId: IssueId('a'),
        targetStateName: 'In Progress',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          kind: 'noop',
          reason: 'already-in-target-state',
          currentStateName: 'IN PROGRESS',
        });
      }
      // Casing preserved — noop does not normalize the existing state.
      expect(tracker.getIssue(IssueId('a'))?.state).toBe('IN PROGRESS');
    });

    it('returns skipped when the target name is not in availableStates', async () => {
      const tracker = new FakeTracker([makeIssue({ id: IssueId('a'), state: 'Todo' })], {
        availableStates: ['Todo', 'Doing', 'Done'],
      });
      const result = await tracker.transitionIssueState({
        issueId: IssueId('a'),
        targetStateName: 'In Progress',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          kind: 'skipped',
          reason: 'target-state-not-found',
          available: ['Todo', 'Doing', 'Done'],
        });
      }
      // Skipped means no mutation.
      expect(tracker.getIssue(IssueId('a'))?.state).toBe('Todo');
    });

    it('records every call in transitionCalls in invocation order', async () => {
      const tracker = new FakeTracker([
        makeIssue({ id: IssueId('a'), state: 'Todo' }),
        makeIssue({ id: IssueId('b'), state: 'Todo' }),
      ]);
      await tracker.transitionIssueState({
        issueId: IssueId('a'),
        targetStateName: 'In Progress',
      });
      await tracker.transitionIssueState({
        issueId: IssueId('b'),
        targetStateName: 'In Progress',
      });
      expect(tracker.transitionCalls.map((c) => c.issueId)).toEqual(['a', 'b']);
    });

    it('queueTransitionResult overrides the next call and is consumed once', async () => {
      const tracker = new FakeTracker([makeIssue({ id: IssueId('a'), state: 'Todo' })]);
      tracker.queueTransitionResult({
        ok: false,
        error: { code: 'linear_api_request', message: 'simulated', cause: new Error('boom') },
      });
      const first = await tracker.transitionIssueState({
        issueId: IssueId('a'),
        targetStateName: 'In Progress',
      });
      expect(first.ok).toBe(false);
      // Issue state was NOT mutated by the simulated-failure path.
      expect(tracker.getIssue(IssueId('a'))?.state).toBe('Todo');
      // Second call returns to default behavior — transitions normally.
      const second = await tracker.transitionIssueState({
        issueId: IssueId('a'),
        targetStateName: 'In Progress',
      });
      expect(second.ok).toBe(true);
      expect(tracker.getIssue(IssueId('a'))?.state).toBe('In Progress');
    });
  });

  describe('mutators', () => {
    it('setIssueState updates one issue and leaves the rest untouched', () => {
      const tracker = new FakeTracker([
        makeIssue({ id: IssueId('a'), state: 'Todo' }),
        makeIssue({ id: IssueId('b'), state: 'Todo' }),
      ]);
      const ok = tracker.setIssueState(IssueId('a'), 'Done');
      expect(ok).toBe(true);
      expect(tracker.getIssue(IssueId('a'))?.state).toBe('Done');
      expect(tracker.getIssue(IssueId('b'))?.state).toBe('Todo');
    });

    it('setIssueState returns false when the issue does not exist', () => {
      const tracker = new FakeTracker([]);
      expect(tracker.setIssueState(IssueId('missing'), 'Done')).toBe(false);
    });

    it('upsertIssue and removeIssue work as expected', () => {
      const tracker = new FakeTracker([]);
      tracker.upsertIssue(makeIssue({ id: IssueId('new') }));
      expect(tracker.getIssue(IssueId('new'))).toBeDefined();
      tracker.removeIssue(IssueId('new'));
      expect(tracker.getIssue(IssueId('new'))).toBeUndefined();
    });
  });
});
