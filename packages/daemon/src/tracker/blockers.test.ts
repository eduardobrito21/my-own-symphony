import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, type BlockerRef, type Issue } from '../types/index.js';

import { hasNonTerminalBlocker, isTodoState } from './blockers.js';

function blocker(state: string | null): BlockerRef {
  return {
    id: state === null ? null : IssueId('id'),
    identifier: state === null ? null : IssueIdentifier('SYMP-99'),
    state,
  };
}

function withBlockers(blockers: BlockerRef[]): Issue {
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
    blockedBy: blockers,
    createdAt: null,
    updatedAt: null,
  };
}

describe('hasNonTerminalBlocker', () => {
  const TERMINAL = ['Done', 'Cancelled'];

  it('returns false when there are no blockers', () => {
    expect(hasNonTerminalBlocker(withBlockers([]), TERMINAL)).toBe(false);
  });

  it('returns false when all blockers are terminal', () => {
    expect(
      hasNonTerminalBlocker(withBlockers([blocker('Done'), blocker('Cancelled')]), TERMINAL),
    ).toBe(false);
  });

  it('returns true when at least one blocker is not in the terminal list', () => {
    expect(hasNonTerminalBlocker(withBlockers([blocker('Done'), blocker('Todo')]), TERMINAL)).toBe(
      true,
    );
  });

  it('treats null blocker state as non-terminal (conservative)', () => {
    expect(hasNonTerminalBlocker(withBlockers([blocker(null)]), TERMINAL)).toBe(true);
  });

  it('matches terminal states case-insensitively', () => {
    expect(hasNonTerminalBlocker(withBlockers([blocker('done')]), TERMINAL)).toBe(false);
  });
});

describe('isTodoState', () => {
  it('matches todo case-insensitively', () => {
    expect(isTodoState('Todo')).toBe(true);
    expect(isTodoState('TODO')).toBe(true);
    expect(isTodoState('todo')).toBe(true);
  });

  it('does not match other states', () => {
    expect(isTodoState('In Progress')).toBe(false);
    expect(isTodoState('Done')).toBe(false);
  });
});
