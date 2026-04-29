import { describe, expect, it } from 'vitest';

import { paginate, type ConnectionPage } from './paginate.js';
import type { TrackerResult } from '../tracker.js';

describe('paginate', () => {
  it('walks the cursor chain and concatenates nodes preserving order', async () => {
    const pages: ConnectionPage<number>[] = [
      { nodes: [1, 2, 3], pageInfo: { hasNextPage: true, endCursor: 'cur-1' } },
      { nodes: [4, 5], pageInfo: { hasNextPage: true, endCursor: 'cur-2' } },
      { nodes: [6], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const calls: (string | null)[] = [];
    const result = await paginate({
      fetchPage: async (after) => {
        calls.push(after);
        const page = pages.shift();
        if (page === undefined) {
          return Promise.resolve({
            ok: false,
            error: { code: 'linear_api_request', message: 'ran out', cause: null },
          } satisfies TrackerResult<ConnectionPage<number>>);
        }
        return Promise.resolve({ ok: true, value: page });
      },
    });
    expect(calls).toEqual([null, 'cur-1', 'cur-2']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns a single page when hasNextPage is false from the start', async () => {
    const result = await paginate<number>({
      fetchPage: () =>
        Promise.resolve({
          ok: true,
          value: { nodes: [1, 2], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2]);
  });

  it('propagates the first failed fetch as the result', async () => {
    let callCount = 0;
    const result = await paginate<number>({
      fetchPage: () => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            value: { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
          });
        }
        return Promise.resolve({
          ok: false,
          error: { code: 'linear_api_status', message: '500', status: 500 },
        });
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('linear_api_status');
    expect(callCount).toBe(2);
  });

  it('returns linear_missing_end_cursor when hasNextPage=true but endCursor=null', async () => {
    const result = await paginate<number>({
      fetchPage: () =>
        Promise.resolve({
          ok: true,
          value: { nodes: [1], pageInfo: { hasNextPage: true, endCursor: null } },
        }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('linear_missing_end_cursor');
  });

  it('caps total pages and fails loudly to avoid infinite loops', async () => {
    const result = await paginate<number>({
      maxPages: 3,
      fetchPage: () =>
        Promise.resolve({
          ok: true,
          value: { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'always' } },
        }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('linear_missing_end_cursor');
  });
});
