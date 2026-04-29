import { describe, expect, it } from 'vitest';

import { normalizeFullIssue, normalizeMinimalIssue } from './normalize.js';
import type { FullIssue, MinimalIssue } from './responses.js';

function makeFull(over: Partial<FullIssue> = {}): FullIssue {
  return {
    id: 'lin_id_1',
    identifier: 'SYMP-1',
    title: 'Title',
    description: 'desc',
    priority: 1,
    state: { name: 'In Progress' },
    branchName: 'symp-1-branch',
    url: 'https://linear.app/example/issue/SYMP-1',
    labels: { nodes: [{ name: 'BUG' }, { name: 'frontend' }] },
    inverseRelations: { nodes: [] },
    createdAt: '2026-04-15T10:00:00.000Z',
    updatedAt: '2026-04-16T11:30:00.000Z',
    ...over,
  };
}

describe('normalizeFullIssue', () => {
  it('maps every field to the domain shape', () => {
    const issue = normalizeFullIssue(makeFull());
    expect(issue.id).toBe('lin_id_1');
    expect(issue.identifier).toBe('SYMP-1');
    expect(issue.title).toBe('Title');
    expect(issue.description).toBe('desc');
    expect(issue.priority).toBe(1);
    expect(issue.state).toBe('In Progress');
    expect(issue.branchName).toBe('symp-1-branch');
    expect(issue.url).toBe('https://linear.app/example/issue/SYMP-1');
    expect(issue.createdAt).toEqual(new Date('2026-04-15T10:00:00.000Z'));
    expect(issue.updatedAt).toEqual(new Date('2026-04-16T11:30:00.000Z'));
  });

  it('lowercases labels (SPEC §11.3)', () => {
    const issue = normalizeFullIssue(
      makeFull({ labels: { nodes: [{ name: 'BUG' }, { name: 'Frontend' }] } }),
    );
    expect(issue.labels).toEqual(['bug', 'frontend']);
  });

  it('preserves null priority / description / branchName / url', () => {
    const issue = normalizeFullIssue(
      makeFull({
        priority: null,
        description: null,
        branchName: null,
        url: null,
      }),
    );
    expect(issue.priority).toBeNull();
    expect(issue.description).toBeNull();
    expect(issue.branchName).toBeNull();
    expect(issue.url).toBeNull();
  });

  it('parses null timestamps to null Date', () => {
    const issue = normalizeFullIssue(makeFull({ createdAt: null, updatedAt: null }));
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
  });

  it('extracts blockers from inverseRelations', () => {
    const issue = normalizeFullIssue(
      makeFull({
        inverseRelations: {
          nodes: [
            {
              type: 'blocks',
              issue: {
                id: 'lin_blocker_1',
                identifier: 'SYMP-99',
                state: { name: 'Todo' },
              },
            },
            {
              type: 'blocks',
              issue: {
                id: 'lin_blocker_2',
                identifier: 'SYMP-100',
                state: { name: 'Done' },
              },
            },
          ],
        },
      }),
    );
    expect(issue.blockedBy).toHaveLength(2);
    expect(issue.blockedBy[0]).toEqual({
      id: 'lin_blocker_1',
      identifier: 'SYMP-99',
      state: 'Todo',
    });
    expect(issue.blockedBy[1]?.state).toBe('Done');
  });

  it('drops blockers whose referenced issue was deleted', () => {
    const issue = normalizeFullIssue(
      makeFull({
        inverseRelations: {
          nodes: [
            { type: 'blocks', issue: null },
            {
              type: 'blocks',
              issue: {
                id: 'lin_blocker_1',
                identifier: 'SYMP-99',
                state: { name: 'Todo' },
              },
            },
          ],
        },
      }),
    );
    expect(issue.blockedBy).toHaveLength(1);
  });

  it('ignores non-blocks inverse relations (duplicate, related)', () => {
    // Linear's GraphQL doesn't let us filter inverseRelations by type,
    // so we filter client-side. This test pins that behavior.
    const issue = normalizeFullIssue(
      makeFull({
        inverseRelations: {
          nodes: [
            {
              type: 'duplicate',
              issue: {
                id: 'lin_dup_1',
                identifier: 'SYMP-200',
                state: { name: 'Done' },
              },
            },
            {
              type: 'related',
              issue: {
                id: 'lin_rel_1',
                identifier: 'SYMP-201',
                state: { name: 'Todo' },
              },
            },
            {
              type: 'blocks',
              issue: {
                id: 'lin_blocker_1',
                identifier: 'SYMP-99',
                state: { name: 'Todo' },
              },
            },
          ],
        },
      }),
    );
    expect(issue.blockedBy).toHaveLength(1);
    expect(issue.blockedBy[0]?.identifier).toBe('SYMP-99');
  });

  it('handles a blocker with null state (unknown)', () => {
    const issue = normalizeFullIssue(
      makeFull({
        inverseRelations: {
          nodes: [
            {
              type: 'blocks',
              issue: {
                id: 'lin_blocker_1',
                identifier: 'SYMP-99',
                state: null,
              },
            },
          ],
        },
      }),
    );
    expect(issue.blockedBy[0]?.state).toBeNull();
  });
});

describe('normalizeMinimalIssue', () => {
  it('fills in placeholders for fields not returned by the minimal query', () => {
    const raw: MinimalIssue = {
      id: 'lin_id_1',
      identifier: 'SYMP-1',
      state: { name: 'Done' },
    };
    const issue = normalizeMinimalIssue(raw);
    expect(issue.id).toBe('lin_id_1');
    expect(issue.identifier).toBe('SYMP-1');
    expect(issue.state).toBe('Done');
    // Placeholders:
    expect(issue.title).toBe('');
    expect(issue.description).toBeNull();
    expect(issue.priority).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.blockedBy).toEqual([]);
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
  });
});
