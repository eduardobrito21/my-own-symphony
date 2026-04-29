// `linear_graphql` — the agent's write-back-to-Linear tool.
//
// Per ADR 0002 we ship our own thin wrapper instead of the hosted
// Linear MCP. The reasons live in that ADR; the practical effect is
// here:
//
//   - Single source of truth for Linear access. The same `LinearClient`
//     instance the tracker uses (read-only polling) is injected here
//     for the agent's read+write traffic. Auth, transport, and error
//     mapping all stay in one place.
//   - No dependency on Linear's hosted MCP server (no extra process,
//     no extra network hop, no auth surface to manage).
//   - The agent never sees the API key. We pass `LinearClient` (which
//     holds the key) into the handler closure; the agent's input only
//     carries the GraphQL string + variables.
//
// Validation order matters for predictable error messages:
//   1. empty / whitespace-only query  -> reject
//   2. graphql.parse throws           -> reject with the parser error
//   3. multi-operation document       -> reject (spec restriction)
//   4. otherwise execute              -> map LinearClient errors to
//      the agent-friendly { success, data, errors, http_status }
//      envelope (SPEC §10.5).
//
// Handler intentionally NEVER throws to the SDK. Errors come back as
// `{ isError: true, content: [{ type: 'text', text: ... }] }`. A
// thrown exception aborts the agent's turn; a structured error lets
// the agent decide how to react (retry, back off, ask for help).

import { Kind, parse, type DefinitionNode } from 'graphql';

import type { LinearClient } from '../../tracker/linear/client.js';

/**
 * Structured payload the agent sees inside the tool result text.
 * Mirror of SPEC §10.5 — kept independent of the MCP `CallToolResult`
 * envelope so this layer can be tested in isolation.
 */
export interface LinearGraphqlPayload {
  /** True iff the GraphQL execution itself succeeded (no transport, status, or graphql errors). */
  readonly success: boolean;
  /** Linear's `data` field on success, `null` on any failure. */
  readonly data: unknown;
  /** Errors as Linear (or our wrapper) reported them, `null` on success. */
  readonly errors: readonly { message: string }[] | null;
  /** HTTP status when known; `null` for transport failures or input-validation failures. */
  readonly http_status: number | null;
}

/**
 * Args the agent supplies. We accept `variables` as a record of
 * unknowns and pass it through; the GraphQL parser doesn't validate
 * variable types — Linear does, and its error message gets surfaced
 * in `errors`.
 */
export interface LinearGraphqlArgs {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

/**
 * Pure function: validate the args, execute via the shared client,
 * and return the agent-facing payload. No SDK types in the signature
 * — easy to unit-test.
 */
export async function executeLinearGraphql(
  client: LinearClient,
  args: LinearGraphqlArgs,
): Promise<LinearGraphqlPayload> {
  const trimmed = args.query.trim();
  if (trimmed === '') {
    return failure('Query string is empty.', null);
  }

  let document;
  try {
    document = parse(args.query);
  } catch (cause) {
    return failure(
      `GraphQL parse error: ${cause instanceof Error ? cause.message : String(cause)}`,
      null,
    );
  }

  const operationCount = document.definitions.filter(isOperation).length;
  if (operationCount > 1) {
    return failure(
      `Multiple operations in one document are not supported (got ${String(operationCount)}). Send one query or mutation at a time.`,
      null,
    );
  }
  if (operationCount === 0) {
    return failure('Document contains no executable operations.', null);
  }

  const result = await client.execute({
    query: args.query,
    variables: args.variables ?? {},
  });

  if (result.ok) {
    return {
      success: true,
      data: result.value,
      errors: null,
      http_status: 200,
    };
  }

  // Map LinearClient errors to the payload's flat shape. The switch
  // is exhaustive over the full `TrackerError` union so a future
  // addition forces us to decide how the agent should see it.
  switch (result.error.code) {
    case 'linear_api_request':
      return failure(`Network error: ${result.error.message}`, null);
    case 'linear_api_status':
      return failure(result.error.message, result.error.status);
    case 'linear_graphql_errors':
      return {
        success: false,
        data: null,
        errors: result.error.errors.map((e) => ({ message: e.message })),
        http_status: 200,
      };
    case 'linear_unknown_payload':
      return failure(result.error.message, null);
    case 'linear_missing_end_cursor':
      // Only emitted by the paginator, but narrowing exhaustively
      // keeps the switch honest.
      return failure(result.error.message, null);
    case 'unsupported_tracker_kind':
    case 'missing_tracker_api_key':
    case 'missing_tracker_project_slug':
      // These are tracker-setup errors emitted by the composition
      // root, never by `LinearClient.execute`. They show up only
      // because they share the `TrackerError` union. Surface as a
      // generic failure if the unexpected ever happens.
      return failure(`Tracker setup error: ${result.error.message}`, null);
  }
}

/**
 * Render the structured payload as the SDK-shaped `CallToolResult`
 * the SDK's `tool()` handler expects. Kept as a separate function so
 * the structured logic can be tested without importing the SDK.
 *
 * Truncates the `text` to a sane upper bound so a runaway response
 * (e.g. a query returning all 50k issues) can't blow up the agent's
 * context window in one shot.
 */
export function toCallToolResult(payload: LinearGraphqlPayload): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  const text = JSON.stringify(payload, null, 2);
  const truncated =
    text.length > MAX_PAYLOAD_TEXT_BYTES
      ? `${text.slice(0, MAX_PAYLOAD_TEXT_BYTES)}\n…[truncated to ${String(MAX_PAYLOAD_TEXT_BYTES)} bytes]`
      : text;
  return {
    content: [{ type: 'text', text: truncated }],
    ...(payload.success ? {} : { isError: true }),
  };
}

export const MAX_PAYLOAD_TEXT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------
// Internals.

function failure(message: string, httpStatus: number | null): LinearGraphqlPayload {
  return {
    success: false,
    data: null,
    errors: [{ message }],
    http_status: httpStatus,
  };
}

function isOperation(def: DefinitionNode): boolean {
  return def.kind === Kind.OPERATION_DEFINITION;
}
