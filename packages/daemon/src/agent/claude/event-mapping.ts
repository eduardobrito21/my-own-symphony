// Map Claude Agent SDK messages onto Symphony's `AgentEvent` union.
//
// This is pure: takes an SDKMessage and a small context object,
// returns zero or more AgentEvents. Exposed as its own module so we
// can test the mapping table without booting the SDK.
//
// Mapping table (anchored to the SDK research notes —
// `agent/claude/sdk-notes.md` §5):
//
//   SDK `system` subtype `init`     -> session_started
//   SDK `system` subtype `status`   -> notification (status string)
//   SDK `system` other subtypes     -> dropped (compact_boundary,
//                                                task_notification, etc.
//                                                are noise for our model)
//   SDK `assistant` text blocks     -> notification (one per block)
//   SDK `assistant` thinking blocks -> notification (with `[thinking]` prefix)
//   SDK `assistant` tool_use blocks -> tool_call (one per block)
//   SDK `user` tool_result blocks   -> tool_result (one per block)
//   SDK `result` subtype `success`  -> usage + turn_completed
//   SDK `result` subtype `error_*`  -> usage + turn_failed
//   SDK `partial_assistant`         -> dropped (streaming deltas would
//                                                duplicate the eventual
//                                                full assistant message)
//   anything else                   -> dropped (lifecycle events that
//                                                belong in operator logs,
//                                                not the orchestrator's
//                                                state machine)
//
// `dropped` does not mean "ignored forever" — the agent runner still
// logs every SDK message at debug level for ops. It just means the
// message doesn't translate into an AgentEvent.

import { SessionId } from '../../types/index.js';
import type { AgentEvent } from '../runner.js';

/**
 * Loose SDKMessage typing. We accept `unknown`-shaped input and
 * narrow per case. Importing the SDK's full union here would couple
 * this module to the SDK package, which makes it harder to mock the
 * mapping in tests. The runtime check is small.
 */
export interface MapContext {
  /**
   * Turn number for this run. Symphony runs one SDK `query()` per
   * `AgentRunInput`, so this is always 1 from the agent's own
   * perspective. The orchestrator carries cross-run context.
   */
  readonly turnNumber: number;
  /** Provider for `at` timestamps. Injectable for deterministic tests. */
  readonly now: () => Date;
}

const NEVER_FAILING: (msg: unknown) => msg is { type: string } = (msg): msg is { type: string } =>
  typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';

/**
 * Translate one SDK message into zero or more AgentEvents. Order of
 * emitted events matters: a `result` message produces `usage` first,
 * THEN `turn_completed` / `turn_failed` so consumers see the totals
 * before the terminal event.
 */
export function mapSdkMessage(rawMsg: unknown, ctx: MapContext): readonly AgentEvent[] {
  if (!NEVER_FAILING(rawMsg)) return [];
  const msg = rawMsg as { type: string } & Record<string, unknown>;
  const at = ctx.now();

  switch (msg.type) {
    case 'system':
      return mapSystemMessage(msg, ctx, at);
    case 'assistant':
      return mapAssistantMessage(msg, at);
    case 'user':
      return mapUserMessage(msg, at);
    case 'result':
      return mapResultMessage(msg, ctx, at);
    default:
      return [];
  }
}

function mapSystemMessage(
  msg: Record<string, unknown>,
  ctx: MapContext,
  at: Date,
): readonly AgentEvent[] {
  const subtype = readString(msg, 'subtype');
  if (subtype === 'init') {
    // The SDK collapses Codex's two-id model into one `session_id`.
    // We map both `sessionId` and `threadId` to the same value and
    // keep `turnId` as the per-run counter so dashboards that show
    // these fields don't suddenly start showing `null`.
    const sessionId = readString(msg, 'session_id') ?? '';
    if (sessionId === '') return [];
    return [
      {
        kind: 'session_started',
        sessionId: SessionId(sessionId),
        threadId: sessionId,
        turnId: `turn-${String(ctx.turnNumber)}`,
        at,
      },
    ];
  }
  if (subtype === 'status') {
    const status = readString(msg, 'status') ?? 'idle';
    return [{ kind: 'notification', message: `status: ${status}`, at }];
  }
  return [];
}

function mapAssistantMessage(msg: Record<string, unknown>, at: Date): readonly AgentEvent[] {
  const inner = msg['message'] as { content?: unknown } | undefined;
  if (inner === undefined) return [];
  const content = inner.content;
  if (!Array.isArray(content)) return [];

  const events: AgentEvent[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const blockType = readString(b, 'type');
    if (blockType === 'text') {
      const text = readString(b, 'text');
      if (text !== null && text !== '') events.push({ kind: 'notification', message: text, at });
    } else if (blockType === 'thinking') {
      const thinking = readString(b, 'thinking');
      if (thinking !== null && thinking !== '') {
        events.push({ kind: 'notification', message: `[thinking] ${thinking}`, at });
      }
    } else if (blockType === 'tool_use') {
      const id = readString(b, 'id') ?? '';
      const name = readString(b, 'name') ?? '';
      events.push({
        kind: 'tool_call',
        callId: id,
        toolName: name,
        input: b['input'] ?? null,
        at,
      });
    }
    // Other block types (image, document, etc.) are not surfaced to
    // the orchestrator — they appear as agent reasoning, not events
    // we need to drive state transitions on.
  }
  return events;
}

function mapUserMessage(msg: Record<string, unknown>, at: Date): readonly AgentEvent[] {
  // The SDK delivers tool_result blocks inside synthetic `user`
  // messages whose `message.content` is an array. We only care
  // about those — pure user prompts (rare in our flow) are dropped.
  const inner = msg['message'] as { content?: unknown } | undefined;
  if (inner === undefined) return [];
  const content = inner.content;
  if (!Array.isArray(content)) return [];

  const events: AgentEvent[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (readString(b, 'type') !== 'tool_result') continue;
    const callId = readString(b, 'tool_use_id') ?? '';
    const isError = b['is_error'] === true;
    events.push({
      kind: 'tool_result',
      callId,
      isError,
      content: stringifyToolResultContent(b['content']),
      at,
    });
  }
  return events;
}

function mapResultMessage(
  msg: Record<string, unknown>,
  ctx: MapContext,
  at: Date,
): readonly AgentEvent[] {
  const subtype = readString(msg, 'subtype');
  const usage = msg['usage'] as Record<string, unknown> | undefined;
  const inputTokens = readNumber(usage, 'input_tokens') ?? 0;
  const outputTokens = readNumber(usage, 'output_tokens') ?? 0;
  const cacheCreation = readNumber(usage, 'cache_creation_input_tokens');
  const cacheRead = readNumber(usage, 'cache_read_input_tokens');
  const totalCost = readNumber(msg, 'total_cost_usd');

  const usageEvent: AgentEvent = {
    kind: 'usage',
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    totalCostUsd: totalCost,
    at,
  };

  if (subtype === 'success') {
    return [usageEvent, { kind: 'turn_completed', turnNumber: ctx.turnNumber, at }];
  }
  // Error subtypes: error_during_execution / error_max_turns /
  // error_max_budget_usd / error_max_structured_output_retries.
  // Pull a human-readable reason: prefer the `errors` list, fall
  // back to the subtype string.
  let reason = subtype ?? 'unknown_error';
  const errors = msg['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    reason = errors.map((e) => String(e)).join('; ');
  }
  return [usageEvent, { kind: 'turn_failed', reason, at }];
}

// ---------------------------------------------------------------------
// Internals.

function readString(obj: Record<string, unknown> | undefined, key: string): string | null {
  if (obj === undefined) return null;
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function readNumber(obj: Record<string, unknown> | undefined, key: string): number | null {
  if (obj === undefined) return null;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * SDK tool_result blocks may carry a string OR an array of content
 * parts (text, image, resource). Collapse to a flat string so the
 * orchestrator's `lastAgentMessage` and the snapshot stay simple.
 */
function stringifyToolResultContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return JSON.stringify(raw);
  const parts: string[] = [];
  for (const block of raw) {
    if (typeof block !== 'object' || block === null) {
      parts.push(String(block));
      continue;
    }
    const b = block as Record<string, unknown>;
    const text = readString(b, 'text');
    if (text !== null) {
      parts.push(text);
      continue;
    }
    parts.push(JSON.stringify(b));
  }
  return parts.join('\n');
}
