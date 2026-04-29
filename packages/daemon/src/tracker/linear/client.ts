// Minimal GraphQL client for Linear's API.
//
// Hand-rolled `fetch` wrapper rather than `graphql-request` because:
//   - Auth header is one specific string (no `Bearer ` prefix per
//     Linear's convention) — easier to get right with our own code.
//   - Errors split into transport / non-200 / GraphQL-errors / parse,
//     each with a distinct domain code (SPEC §11.4). A library wraps
//     errors in its own taxonomy that we'd have to translate.
//   - One dependency we don't have to keep updated.
//
// Per SPEC §11.2: 30 second network timeout, default endpoint is
// `https://api.linear.app/graphql`.

import { z } from 'zod';

import type {
  LinearApiRequestError,
  LinearApiStatusError,
  LinearGraphqlErrors,
  LinearUnknownPayload,
  TrackerResult,
} from '../tracker.js';

const NETWORK_TIMEOUT_MS = 30_000;

export interface LinearClientArgs {
  /** GraphQL endpoint URL. Defaults to Linear's public endpoint. */
  readonly endpoint: string;
  /** Linear API token. Sent verbatim in `Authorization`. */
  readonly apiKey: string;
  /**
   * Optional `fetch` override (for tests). Defaults to global `fetch`.
   */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface GraphqlExecuteArgs<TVars> {
  readonly query: string;
  readonly variables?: TVars;
  /** Override the timeout (ms). Default 30 s per SPEC §11.2. */
  readonly timeoutMs?: number;
}

/**
 * Generic GraphQL response envelope. Both `data` and `errors` are
 * optional — a partial response can include both (some queries
 * succeeded, some had errors). We surface errors as failures even
 * when partial data is present, but we keep the body for debugging.
 */
const GraphqlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      }),
    )
    .optional(),
});

export class LinearClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(args: LinearClientArgs) {
    this.endpoint = args.endpoint;
    this.apiKey = args.apiKey;
    this.fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Execute a single GraphQL operation. Returns the raw `data` field
   * (`unknown`) on success — the caller is responsible for parsing
   * with the appropriate zod schema.
   *
   * Error category mapping (SPEC §11.4):
   *   - fetch threw    -> linear_api_request
   *   - non-200 status -> linear_api_status
   *   - errors[]       -> linear_graphql_errors (preserves body)
   *   - body shape bad -> linear_unknown_payload
   */
  async execute<TVars = Record<string, unknown>>(
    args: GraphqlExecuteArgs<TVars>,
  ): Promise<TrackerResult<unknown>> {
    const timeoutMs = args.timeoutMs ?? NETWORK_TIMEOUT_MS;

    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Linear's docs: token goes in Authorization with no
          // `Bearer ` prefix. This is a Linear-specific convention.
          Authorization: this.apiKey,
        },
        body: JSON.stringify({
          query: args.query,
          variables: args.variables,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const error: LinearApiRequestError = {
        code: 'linear_api_request',
        message: `Linear API request failed: ${stringifyCause(cause)}`,
        cause,
      };
      return { ok: false, error };
    }

    if (!response.ok) {
      // Drain the body for the error message but bound it.
      let snippet = '';
      try {
        snippet = (await response.text()).slice(0, 512);
      } catch {
        snippet = '<unreadable body>';
      }
      const error: LinearApiStatusError = {
        code: 'linear_api_status',
        status: response.status,
        message: `Linear API returned ${String(response.status)}: ${snippet}`,
      };
      return { ok: false, error };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      const error: LinearUnknownPayload = {
        code: 'linear_unknown_payload',
        message: `Linear API response was not valid JSON: ${stringifyCause(cause)}`,
      };
      return { ok: false, error };
    }

    const parsed = GraphqlResponseSchema.safeParse(body);
    if (!parsed.success) {
      const error: LinearUnknownPayload = {
        code: 'linear_unknown_payload',
        message: `Linear API response did not match expected envelope: ${parsed.error.message}`,
      };
      return { ok: false, error };
    }

    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      const error: LinearGraphqlErrors = {
        code: 'linear_graphql_errors',
        message: parsed.data.errors.map((e) => e.message).join('; '),
        errors: parsed.data.errors,
      };
      return { ok: false, error };
    }

    if (parsed.data.data === undefined) {
      const error: LinearUnknownPayload = {
        code: 'linear_unknown_payload',
        message: 'Linear API response had neither `data` nor `errors`.',
      };
      return { ok: false, error };
    }

    return { ok: true, value: parsed.data.data };
  }
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
