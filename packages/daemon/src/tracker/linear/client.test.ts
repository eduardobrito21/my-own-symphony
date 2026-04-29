// LinearClient unit tests using a stub fetch.
//
// We don't hit Linear's real API here — those tests would be a
// "Real Integration Profile" check (SPEC §17.8) that requires a
// `LINEAR_API_KEY` and creates real artifacts. That's gated to
// CI/manual runs.

import { describe, expect, it } from 'vitest';

import { LinearClient } from './client.js';

interface StubArgs {
  readonly status?: number;
  readonly body?: unknown;
  readonly textBody?: string;
  readonly throws?: unknown;
}

function stubFetch(args: StubArgs = {}): typeof globalThis.fetch {
  // eslint-disable-next-line @typescript-eslint/require-await
  const impl = async (): Promise<Response> => {
    if (args.throws !== undefined) {
      // Tests pass Error instances (or sometimes raw strings); we
      // re-throw verbatim. ESLint flags the non-Error path; suppress
      // because that's the behavior we're testing.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw args.throws;
    }
    const status = args.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(args.body),
      text: () =>
        Promise.resolve(
          args.textBody ?? (args.body !== undefined ? JSON.stringify(args.body) : ''),
        ),
    } as unknown as Response;
  };
  return impl;
}

const COMMON_ARGS = { endpoint: 'https://example.test/graphql', apiKey: 'test-key' };

describe('LinearClient.execute', () => {
  it('returns the data field on success', async () => {
    const client = new LinearClient({
      ...COMMON_ARGS,
      fetchImpl: stubFetch({ body: { data: { hello: 'world' } } }),
    });
    const result = await client.execute({ query: 'query { hello }' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ hello: 'world' });
  });

  it('maps fetch failure to linear_api_request', async () => {
    const client = new LinearClient({
      ...COMMON_ARGS,
      fetchImpl: stubFetch({ throws: new Error('ECONNREFUSED') }),
    });
    const result = await client.execute({ query: 'q' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('linear_api_request');
      expect(result.error.message).toContain('ECONNREFUSED');
    }
  });

  it('maps non-200 to linear_api_status', async () => {
    const client = new LinearClient({
      ...COMMON_ARGS,
      fetchImpl: stubFetch({ status: 500, textBody: 'Internal Error' }),
    });
    const result = await client.execute({ query: 'q' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('linear_api_status');
      if (result.error.code === 'linear_api_status') {
        expect(result.error.status).toBe(500);
      }
    }
  });

  it('maps GraphQL errors to linear_graphql_errors and preserves the body', async () => {
    const client = new LinearClient({
      ...COMMON_ARGS,
      fetchImpl: stubFetch({
        body: {
          data: null,
          errors: [{ message: 'Bad input on $projectSlug' }],
        },
      }),
    });
    const result = await client.execute({ query: 'q' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('linear_graphql_errors');
      if (result.error.code === 'linear_graphql_errors') {
        expect(result.error.errors).toHaveLength(1);
        expect(result.error.errors[0]?.message).toContain('Bad input');
      }
    }
  });

  it('maps unparseable body to linear_unknown_payload', async () => {
    const client = new LinearClient({
      ...COMMON_ARGS,
      // No `data` and no `errors` -> envelope is missing both.
      fetchImpl: stubFetch({ body: { something_else: 1 } }),
    });
    const result = await client.execute({ query: 'q' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('linear_unknown_payload');
  });

  it('sends the API key as the Authorization header (no Bearer prefix)', async () => {
    let capturedAuth = '';
    // eslint-disable-next-line @typescript-eslint/require-await
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      capturedAuth = headers.get('authorization') ?? '';
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: {} }),
        text: () => Promise.resolve(''),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const client = new LinearClient({ ...COMMON_ARGS, apiKey: 'lin_test_key', fetchImpl });
    await client.execute({ query: 'q' });
    expect(capturedAuth).toBe('lin_test_key');
    expect(capturedAuth).not.toMatch(/^Bearer/);
  });
});
