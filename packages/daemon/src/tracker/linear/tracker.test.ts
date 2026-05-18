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

describe('LinearTracker.transitionIssueState (Plan 23)', () => {
  // Helper: yields a stub that returns workflow-states + current
  // state on the lookup query, and a successful issueUpdate on the
  // mutation. Captures call args for assertion.
  function buildStubbedTracker(opts: {
    readonly currentState: string;
    readonly availableStates: readonly { id: string; name: string }[];
    readonly mutateResponse?: {
      readonly success: boolean;
      readonly toName: string;
    };
  }): {
    tracker: LinearTracker;
    calls: { query: string; variables: unknown }[];
  } {
    const calls: { query: string; variables: unknown }[] = [];
    const tracker = buildTrackerWithMockExecute((args) => {
      calls.push({ query: args.query, variables: args.variables });
      if (args.query.includes('IssueWorkflowStates')) {
        return Promise.resolve({
          ok: true,
          value: {
            issue: {
              id: 'lin_id_1',
              state: { name: opts.currentState },
              team: {
                states: { nodes: opts.availableStates },
              },
            },
          },
        });
      }
      // IssueUpdateState mutation
      return Promise.resolve({
        ok: true,
        value: {
          issueUpdate: {
            success: opts.mutateResponse?.success ?? true,
            issue: {
              id: 'lin_id_1',
              state: { name: opts.mutateResponse?.toName ?? 'In Progress' },
            },
          },
        },
      });
    });
    return { tracker, calls };
  }

  it('transitions an issue and issues the mutation with the resolved stateId', async () => {
    const { tracker, calls } = buildStubbedTracker({
      currentState: 'Todo',
      availableStates: [
        { id: 'state-todo', name: 'Todo' },
        { id: 'state-inprog', name: 'In Progress' },
        { id: 'state-done', name: 'Done' },
      ],
      mutateResponse: { success: true, toName: 'In Progress' },
    });
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
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
    // Two calls: lookup + mutate.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain('IssueWorkflowStates');
    expect(calls[1]?.query).toContain('IssueUpdateState');
    expect(calls[1]?.variables).toEqual({
      issueId: 'lin_id_1',
      stateId: 'state-inprog',
    });
  });

  it('matches the target state name case-insensitively (operator typed "in progress")', async () => {
    const { tracker, calls } = buildStubbedTracker({
      currentState: 'Todo',
      availableStates: [
        { id: 'state-todo', name: 'Todo' },
        { id: 'state-inprog', name: 'In Progress' },
      ],
    });
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
      targetStateName: 'in progress',
    });
    expect(result.ok).toBe(true);
    expect(calls[1]?.variables).toEqual({
      issueId: 'lin_id_1',
      stateId: 'state-inprog',
    });
  });

  it('returns kind: noop when the issue is already in the target state (no mutation issued)', async () => {
    const { tracker, calls } = buildStubbedTracker({
      currentState: 'In Progress',
      availableStates: [
        { id: 'state-todo', name: 'Todo' },
        { id: 'state-inprog', name: 'In Progress' },
      ],
    });
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
      targetStateName: 'In Progress',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: 'noop',
        reason: 'already-in-target-state',
        currentStateName: 'In Progress',
      });
    }
    // Only the lookup ran — mutation was short-circuited.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('IssueWorkflowStates');
  });

  it('returns kind: skipped when target name does not match any team state (no mutation issued)', async () => {
    const { tracker, calls } = buildStubbedTracker({
      currentState: 'Todo',
      availableStates: [
        { id: 'state-todo', name: 'Todo' },
        { id: 'state-doing', name: 'Doing' },
        { id: 'state-done', name: 'Done' },
      ],
    });
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
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
    // Only the lookup ran.
    expect(calls).toHaveLength(1);
  });

  it('returns linear_unknown_payload when the lookup returns a null issue', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({
        ok: true,
        value: { issue: null },
      }),
    );
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
      targetStateName: 'In Progress',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('linear_unknown_payload');
    }
  });

  it('returns linear_unknown_payload when issueUpdate.success is false', async () => {
    const { tracker } = buildStubbedTracker({
      currentState: 'Todo',
      availableStates: [{ id: 'state-inprog', name: 'In Progress' }],
      mutateResponse: { success: false, toName: 'In Progress' },
    });
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
      targetStateName: 'In Progress',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('linear_unknown_payload');
    }
  });

  it('propagates transport errors from the underlying client', async () => {
    const tracker = buildTrackerWithMockExecute(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: 'linear_api_request',
          message: 'simulated network failure',
          cause: new Error('boom'),
        },
      }),
    );
    const result = await tracker.transitionIssueState({
      issueId: IssueId('lin_id_1'),
      targetStateName: 'In Progress',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('linear_api_request');
    }
  });
});
