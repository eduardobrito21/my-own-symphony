// Unit tests for the `linear_graphql` tool handler.
//
// These tests target the pure `executeLinearGraphql` function — no
// SDK boot, no real Linear API calls. Validation and error mapping
// are the points of interest; the actual HTTP path is the Linear
// client's responsibility (already tested separately).

import { describe, expect, it, vi } from 'vitest';

import type { LinearClient } from '../../tracker/linear/client.js';
import type { TrackerResult } from '../../tracker/tracker.js';

import {
  MAX_PAYLOAD_TEXT_BYTES,
  executeLinearGraphql,
  toCallToolResult,
} from './linear-graphql.js';

function stubClient(execute: LinearClient['execute']): LinearClient {
  // Cast: we only need `execute` for the handler, the rest of
  // LinearClient's surface is irrelevant here.
  return { execute } as unknown as LinearClient;
}

const VALID_QUERY = `
  query Q($id: String!) {
    issue(id: $id) { id identifier }
  }
`;

describe('executeLinearGraphql — validation', () => {
  it('rejects an empty query', async () => {
    const client = stubClient(() => Promise.resolve({ ok: true, value: {} }));
    const got = await executeLinearGraphql(client, { query: '' });
    expect(got.success).toBe(false);
    expect(got.errors?.[0]?.message).toBe('Query string is empty.');
    expect(got.http_status).toBeNull();
  });

  it('rejects whitespace-only queries', async () => {
    const client = stubClient(() => Promise.resolve({ ok: true, value: {} }));
    const got = await executeLinearGraphql(client, { query: '   \n\t  ' });
    expect(got.success).toBe(false);
    expect(got.errors?.[0]?.message).toBe('Query string is empty.');
  });

  it('rejects unparseable GraphQL with the parser error message', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: {} } as TrackerResult<unknown>));
    const client = stubClient(execute);
    const got = await executeLinearGraphql(client, { query: 'query { foo' });
    expect(got.success).toBe(false);
    expect(got.errors?.[0]?.message).toMatch(/GraphQL parse error/);
    // Crucially: we do NOT call the network on parse failure.
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects multi-operation documents', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: {} } as TrackerResult<unknown>));
    const client = stubClient(execute);
    const multi = `
      query A { viewer { id } }
      query B { teams { nodes { id } } }
    `;
    const got = await executeLinearGraphql(client, { query: multi });
    expect(got.success).toBe(false);
    expect(got.errors?.[0]?.message).toMatch(/Multiple operations/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects fragment-only documents (no executable operation)', async () => {
    const fragmentOnly = `
      fragment IssueFields on Issue { id identifier }
    `;
    const got = await executeLinearGraphql(stubClient(vi.fn()), { query: fragmentOnly });
    expect(got.success).toBe(false);
    expect(got.errors?.[0]?.message).toMatch(/no executable operations/);
  });
});

describe('executeLinearGraphql — execution and error mapping', () => {
  it('returns success payload on a 200 with data', async () => {
    const client = stubClient(() =>
      Promise.resolve({ ok: true, value: { issue: { id: 'u1', identifier: 'EDU-1' } } }),
    );
    const got = await executeLinearGraphql(client, {
      query: VALID_QUERY,
      variables: { id: 'EDU-1' },
    });
    expect(got.success).toBe(true);
    expect(got.http_status).toBe(200);
    expect(got.errors).toBeNull();
    expect(got.data).toEqual({ issue: { id: 'u1', identifier: 'EDU-1' } });
  });

  it('passes variables through to the LinearClient unchanged', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: {} } as TrackerResult<unknown>));
    const client = stubClient(execute);
    await executeLinearGraphql(client, {
      query: VALID_QUERY,
      variables: { id: 'EDU-7', extra: { foo: 'bar' } },
    });
    expect(execute).toHaveBeenCalledWith({
      query: VALID_QUERY,
      variables: { id: 'EDU-7', extra: { foo: 'bar' } },
    });
  });

  it('defaults variables to {} when omitted', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: {} } as TrackerResult<unknown>));
    const client = stubClient(execute);
    await executeLinearGraphql(client, { query: VALID_QUERY });
    expect(execute).toHaveBeenCalledWith({ query: VALID_QUERY, variables: {} });
  });

  it('maps linear_api_status (4xx/5xx) preserving status code', async () => {
    const client = stubClient(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'linear_api_status', status: 401, message: 'unauthorized' },
      }),
    );
    const got = await executeLinearGraphql(client, { query: VALID_QUERY });
    expect(got.success).toBe(false);
    expect(got.http_status).toBe(401);
    expect(got.errors?.[0]?.message).toBe('unauthorized');
  });

  it('maps linear_graphql_errors with a 200 status and per-error messages', async () => {
    const client = stubClient(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: 'linear_graphql_errors',
          message: 'A; B',
          errors: [{ message: 'A' }, { message: 'B' }],
        },
      }),
    );
    const got = await executeLinearGraphql(client, { query: VALID_QUERY });
    expect(got.success).toBe(false);
    expect(got.http_status).toBe(200);
    expect(got.errors).toEqual([{ message: 'A' }, { message: 'B' }]);
  });

  it('maps linear_api_request (transport) with no status', async () => {
    const client = stubClient(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'linear_api_request', message: 'connection reset', cause: undefined },
      }),
    );
    const got = await executeLinearGraphql(client, { query: VALID_QUERY });
    expect(got.success).toBe(false);
    expect(got.http_status).toBeNull();
    expect(got.errors?.[0]?.message).toMatch(/Network error/);
  });

  it('does not throw on 5xx — returns a structured failure', async () => {
    const client = stubClient(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'linear_api_status', status: 503, message: 'service unavailable' },
      }),
    );
    // The agent must never see the tool throw; it sees an error
    // payload it can read and react to.
    await expect(executeLinearGraphql(client, { query: VALID_QUERY })).resolves.toMatchObject({
      success: false,
      http_status: 503,
    });
  });
});

describe('toCallToolResult', () => {
  it('returns content with a single text block on success', () => {
    const got = toCallToolResult({
      success: true,
      data: { ok: 1 },
      errors: null,
      http_status: 200,
    });
    expect(got.content).toHaveLength(1);
    expect(got.content[0]?.type).toBe('text');
    expect(JSON.parse(got.content[0]?.text ?? '') as { ok: number }).toEqual(
      expect.objectContaining({ success: true, http_status: 200 }),
    );
    expect(got.isError).toBeUndefined();
  });

  it('sets isError: true when the payload reports failure', () => {
    const got = toCallToolResult({
      success: false,
      data: null,
      errors: [{ message: 'boom' }],
      http_status: 500,
    });
    expect(got.isError).toBe(true);
  });

  it('truncates very large payloads to MAX_PAYLOAD_TEXT_BYTES', () => {
    const big = 'x'.repeat(MAX_PAYLOAD_TEXT_BYTES + 1000);
    const got = toCallToolResult({
      success: true,
      data: big,
      errors: null,
      http_status: 200,
    });
    expect(got.content[0]?.text.length).toBeLessThanOrEqual(MAX_PAYLOAD_TEXT_BYTES + 100);
    expect(got.content[0]?.text).toMatch(/truncated/);
  });
});
