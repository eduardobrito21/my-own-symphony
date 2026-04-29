// Cursor-based pagination over Linear's relay-style connections.
//
// Linear paginates with `first: N, after: cursor` and returns
// `pageInfo: { hasNextPage, endCursor }`. We loop until
// `hasNextPage === false`, accumulating nodes.
//
// SPEC §11.4 includes `linear_missing_end_cursor` as a typed error:
// if `hasNextPage` is true but `endCursor` is null we'd loop forever
// with the same args. Fail loudly instead.

import type { LinearMissingEndCursor, TrackerError, TrackerResult } from '../tracker.js';

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface ConnectionPage<T> {
  readonly nodes: readonly T[];
  readonly pageInfo: PageInfo;
}

export interface PaginateArgs<T> {
  /**
   * Fetch one page given a cursor (`null` for the first page). Each
   * call should set the page-size argument internally; this helper
   * doesn't know the variable name in your query.
   */
  readonly fetchPage: (after: string | null) => Promise<TrackerResult<ConnectionPage<T>>>;
  /** Safety cap on total pages. Avoids infinite-loop bugs. Default 200. */
  readonly maxPages?: number;
}

/**
 * Walk the cursor chain, accumulating all nodes. Returns the full
 * list on success; fails on the first page that returns an error.
 */
export async function paginate<T>(args: PaginateArgs<T>): Promise<TrackerResult<readonly T[]>> {
  const maxPages = args.maxPages ?? 200;
  const acc: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await args.fetchPage(cursor);
    if (!result.ok) {
      return result;
    }
    for (const node of result.value.nodes) {
      acc.push(node);
    }
    if (!result.value.pageInfo.hasNextPage) {
      return { ok: true, value: acc };
    }
    if (result.value.pageInfo.endCursor === null) {
      const error: LinearMissingEndCursor = {
        code: 'linear_missing_end_cursor',
        message: `Linear pagination integrity error: hasNextPage=true but endCursor=null after ${String(page + 1)} page(s) (${String(acc.length)} nodes).`,
      };
      return { ok: false, error };
    }
    cursor = result.value.pageInfo.endCursor;
  }
  // Hit the page cap. Treat as integrity error.
  const error: TrackerError = {
    code: 'linear_missing_end_cursor',
    message: `Pagination exceeded ${String(maxPages)} pages; suspecting an infinite loop. Accumulated ${String(acc.length)} nodes.`,
  };
  return { ok: false, error };
}
