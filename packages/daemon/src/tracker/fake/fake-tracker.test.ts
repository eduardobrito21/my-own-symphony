import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, type Issue } from '../../types/index.js';

import { FakeTracker } from './fake-tracker.js';

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
