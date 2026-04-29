// LinearTracker integration tests using a stubbed LinearClient.
//
// We assemble the full pipeline (query -> client -> response schema
// -> normalize) and verify that the LinearTracker's three Tracker
// methods produce correctly-shaped domain `Issue`s.

import { describe, expect, it, vi } from 'vitest';

import { LinearClient } from './client.js';
import { LinearTracker } from './tracker.js';
import type { TrackerResult } from '../tracker.js';
import { IssueId } from '../../types/index.js';

function buildTrackerWithMockExecute(
  execute: (args: { query: string; variables?: unknown }) => Promise<TrackerResult<unknown>>,
): LinearTracker {
  // We bypass the real LinearClient by overriding `execute`.
  const client = new LinearClient({ endpoint: 'https://example.test', apiKey: 'k' });
  // The mock signature lines up with execute's<TVars> generic shape;
  // TS's inference there happens to accept it without a cast.
  vi.spyOn(client, 'execute').mockImplementation(execute);
  return new LinearTracker({ client, projectSlug: 'demo' });
}

const SAMPLE_FULL_NODE = {
  id: 'lin_id_1',
  identifier: 'SYMP-1',
  title: 'Hello',
  description: 'desc',
  priority: 1,
  state: { name: 'In Progress' },
  branchName: 'symp-1',
  url: 'https://linear.app/example/issue/SYMP-1',
  labels: { nodes: [{ name: 'BUG' }] },
  inverseRelations: { nodes: [] },
  createdAt: '2026-04-15T10:00:00.000Z',
  updatedAt: '2026-04-16T10:00:00.000Z',
};

describe('LinearTracker.fetchCandidateIssues', () => {
  it('returns normalized issues from a single page', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({
        ok: true,
        value: {
          issues: {
            nodes: [SAMPLE_FULL_NODE],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const result = await tracker.fetchCandidateIssues({ activeStates: ['Todo'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.identifier).toBe('SYMP-1');
      expect(result.value[0]?.labels).toEqual(['bug']);
    }
  });

  it('paginates across multiple pages preserving order', async () => {
    let call = 0;
    const tracker = buildTrackerWithMockExecute(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          value: {
            issues: {
              nodes: [
                SAMPLE_FULL_NODE,
                { ...SAMPLE_FULL_NODE, id: 'lin_id_2', identifier: 'SYMP-2' },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
            },
          },
        });
      }
      return Promise.resolve({
        ok: true,
        value: {
          issues: {
            nodes: [{ ...SAMPLE_FULL_NODE, id: 'lin_id_3', identifier: 'SYMP-3' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    });
    const result = await tracker.fetchCandidateIssues({ activeStates: ['Todo'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((i) => i.identifier)).toEqual(['SYMP-1', 'SYMP-2', 'SYMP-3']);
    }
  });

  it('returns linear_unknown_payload when the schema does not match', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({ ok: true, value: { issues: 'wrong shape' } }),
    );
    const result = await tracker.fetchCandidateIssues({ activeStates: ['Todo'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('linear_unknown_payload');
  });

  it('propagates client errors through the result', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'linear_api_status', message: '500', status: 500 },
      }),
    );
    const result = await tracker.fetchCandidateIssues({ activeStates: ['Todo'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('linear_api_status');
  });
});

describe('LinearTracker.fetchIssuesByStates', () => {
  it('short-circuits to empty when no states are given (no API call)', async () => {
    const execute = vi.fn();
    const tracker = buildTrackerWithMockExecute(execute as never);
    const result = await tracker.fetchIssuesByStates({ states: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns normalized issues for the matching states', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({
        ok: true,
        value: {
          issues: {
            nodes: [SAMPLE_FULL_NODE],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const result = await tracker.fetchIssuesByStates({ states: ['Done'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe('lin_id_1');
    }
  });
});

describe('LinearTracker.fetchIssueStatesByIds', () => {
  it('short-circuits to empty for empty ids', async () => {
    const execute = vi.fn();
    const tracker = buildTrackerWithMockExecute(execute as never);
    const result = await tracker.fetchIssueStatesByIds({ ids: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns minimal issues with id/identifier/state populated and other fields placeholders', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({
        ok: true,
        value: {
          issues: {
            nodes: [
              {
                id: 'lin_id_1',
                identifier: 'SYMP-1',
                state: { name: 'Done' },
              },
            ],
          },
        },
      }),
    );
    const result = await tracker.fetchIssueStatesByIds({ ids: [IssueId('lin_id_1')] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const issue = result.value[0];
      expect(issue?.state).toBe('Done');
      // Placeholders for fields not in the minimal query:
      expect(issue?.title).toBe('');
      expect(issue?.labels).toEqual([]);
      expect(issue?.blockedBy).toEqual([]);
    }
  });
});
