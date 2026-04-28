import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, type Issue } from '../types/index.js';

import { sortForDispatch } from './sort.js';

/**
 * Build a minimal `Issue` for sort-order tests. Only the fields the
 * sorter looks at (`priority`, `createdAt`, `identifier`) and the
 * required identity fields are populated.
 */
function makeIssue(
  identifier: string,
  options: { priority?: number | null; createdAt?: Date | null } = {},
): Issue {
  return {
    id: IssueId(`id-${identifier}`),
    identifier: IssueIdentifier(identifier),
    title: 'title',
    description: null,
    priority: options.priority ?? null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: options.createdAt ?? null,
    updatedAt: null,
  };
}

describe('sortForDispatch', () => {
  it('sorts by priority ascending (1 is highest)', () => {
    const result = sortForDispatch([
      makeIssue('A', { priority: 4 }),
      makeIssue('B', { priority: 1 }),
      makeIssue('C', { priority: 2 }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['B', 'C', 'A']);
  });

  it('sorts null priority after numeric priorities', () => {
    const result = sortForDispatch([
      makeIssue('A', { priority: null }),
      makeIssue('B', { priority: 3 }),
      makeIssue('C', { priority: 1 }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['C', 'B', 'A']);
  });

  it('breaks ties on priority with createdAt (oldest first)', () => {
    const result = sortForDispatch([
      makeIssue('A', { priority: 2, createdAt: new Date('2026-04-15') }),
      makeIssue('B', { priority: 2, createdAt: new Date('2026-04-10') }),
      makeIssue('C', { priority: 2, createdAt: new Date('2026-04-20') }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['B', 'A', 'C']);
  });

  it('sorts null createdAt after non-null createdAt at the same priority', () => {
    const result = sortForDispatch([
      makeIssue('A', { priority: 2, createdAt: null }),
      makeIssue('B', { priority: 2, createdAt: new Date('2026-04-10') }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['B', 'A']);
  });

  it('breaks ties on priority+createdAt with identifier (lex)', () => {
    const sameTime = new Date('2026-04-15');
    const result = sortForDispatch([
      makeIssue('SYMP-30', { priority: 2, createdAt: sameTime }),
      makeIssue('SYMP-10', { priority: 2, createdAt: sameTime }),
      makeIssue('SYMP-20', { priority: 2, createdAt: sameTime }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['SYMP-10', 'SYMP-20', 'SYMP-30']);
  });

  it('does not mutate the input array', () => {
    const input = [makeIssue('A', { priority: 4 }), makeIssue('B', { priority: 1 })];
    const before = input.map((i) => i.identifier);
    sortForDispatch(input);
    expect(input.map((i) => i.identifier)).toEqual(before);
  });
});
