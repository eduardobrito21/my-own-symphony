// Unit tests for the SDK message → AgentEvent mapping table.
//
// We feed hand-crafted SDKMessage-shaped objects into `mapSdkMessage`
// and assert on the emitted AgentEvent sequence. No SDK boot, no
// network — these run in milliseconds.

import { describe, expect, it } from 'vitest';

import { mapSdkMessage, type MapContext } from './event-mapping.js';

const AT = new Date('2026-04-29T10:00:00.000Z');
const CTX: MapContext = {
  turnNumber: 1,
  now: () => AT,
};

describe('mapSdkMessage — system messages', () => {
  it('maps init to session_started with the sdk session_id', () => {
    const got = mapSdkMessage({ type: 'system', subtype: 'init', session_id: 'sess-uuid-1' }, CTX);
    expect(got).toEqual([
      {
        kind: 'session_started',
        sessionId: 'sess-uuid-1',
        threadId: 'sess-uuid-1',
        turnId: 'turn-1',
        at: AT,
      },
    ]);
  });

  it('maps status to a notification with the status string', () => {
    const got = mapSdkMessage({ type: 'system', subtype: 'status', status: 'compacting' }, CTX);
    expect(got).toEqual([{ kind: 'notification', message: 'status: compacting', at: AT }]);
  });

  it('drops other system subtypes (compact_boundary, task_notification, etc.)', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'compact_boundary' }, CTX)).toEqual([]);
    expect(mapSdkMessage({ type: 'system', subtype: 'task_notification' }, CTX)).toEqual([]);
  });

  it('drops init with empty session_id (defensive — never observed in real SDK)', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'init', session_id: '' }, CTX)).toEqual([]);
  });
});

describe('mapSdkMessage — assistant messages', () => {
  it('maps a text block to a notification', () => {
    const got = mapSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
      CTX,
    );
    expect(got).toEqual([{ kind: 'notification', message: 'hello', at: AT }]);
  });

  it('skips empty text blocks (avoid log spam from streaming artifacts)', () => {
    const got = mapSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '' }] },
      },
      CTX,
    );
    expect(got).toEqual([]);
  });

  it('prefixes thinking blocks with [thinking] so consumers can filter them', () => {
    const got = mapSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'planning…' }] },
      },
      CTX,
    );
    expect(got).toEqual([{ kind: 'notification', message: '[thinking] planning…', at: AT }]);
  });

  it('maps tool_use blocks to tool_call events with id + name + input', () => {
    const got = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'mcp__linear__linear_graphql',
              input: { query: '{ viewer { id } }' },
            },
          ],
        },
      },
      CTX,
    );
    expect(got).toEqual([
      {
        kind: 'tool_call',
        callId: 'call-1',
        toolName: 'mcp__linear__linear_graphql',
        input: { query: '{ viewer { id } }' },
        at: AT,
      },
    ]);
  });

  it('emits multiple events for assistant messages with mixed blocks', () => {
    const got = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'tool_use', id: 'call-2', name: 'Read', input: { path: 'foo' } },
          ],
        },
      },
      CTX,
    );
    expect(got).toHaveLength(2);
    expect(got[0]?.kind).toBe('notification');
    expect(got[1]?.kind).toBe('tool_call');
  });
});

describe('mapSdkMessage — user messages (tool_result blocks)', () => {
  it('maps a tool_result block to a tool_result event', () => {
    const got = mapSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              is_error: false,
              content: 'OK',
            },
          ],
        },
      },
      CTX,
    );
    expect(got).toEqual([
      { kind: 'tool_result', callId: 'call-1', isError: false, content: 'OK', at: AT },
    ]);
  });

  it('flattens an array-of-text-blocks tool_result content into a newline-joined string', () => {
    const got = mapSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              is_error: false,
              content: [
                { type: 'text', text: 'line A' },
                { type: 'text', text: 'line B' },
              ],
            },
          ],
        },
      },
      CTX,
    );
    expect(got[0]?.kind).toBe('tool_result');
    if (got[0]?.kind === 'tool_result') {
      expect(got[0].content).toBe('line A\nline B');
    }
  });

  it('flags tool_result errors via isError', () => {
    const got = mapSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-bad',
              is_error: true,
              content: 'tool blew up',
            },
          ],
        },
      },
      CTX,
    );
    if (got[0]?.kind === 'tool_result') {
      expect(got[0].isError).toBe(true);
    } else {
      throw new Error('expected tool_result event');
    }
  });

  it('drops user messages with no tool_result blocks (e.g. plain prompts)', () => {
    expect(
      mapSdkMessage({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }, CTX),
    ).toEqual([]);
  });
});

describe('mapSdkMessage — result messages', () => {
  it('emits usage then turn_completed on success', () => {
    const got = mapSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1500, output_tokens: 200 },
        total_cost_usd: 0.0123,
      },
      CTX,
    );
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      kind: 'usage',
      inputTokens: 1500,
      outputTokens: 200,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      totalCostUsd: 0.0123,
      at: AT,
    });
    expect(got[1]).toEqual({ kind: 'turn_completed', turnNumber: 1, at: AT });
  });

  it('forwards cache token fields when present', () => {
    const got = mapSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 30,
        },
        total_cost_usd: 0,
      },
      CTX,
    );
    if (got[0]?.kind === 'usage') {
      expect(got[0].cacheCreationInputTokens).toBe(50);
      expect(got[0].cacheReadInputTokens).toBe(30);
    } else {
      throw new Error('expected usage first');
    }
  });

  it('emits usage then turn_failed on error subtypes, with errors[] joined', () => {
    const got = mapSdkMessage(
      {
        type: 'result',
        subtype: 'error_during_execution',
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
        errors: ['rate limited', 'session aborted'],
      },
      CTX,
    );
    expect(got).toHaveLength(2);
    expect(got[1]).toEqual({
      kind: 'turn_failed',
      reason: 'rate limited; session aborted',
      at: AT,
    });
  });

  it('falls back to the subtype string when errors[] is empty', () => {
    const got = mapSdkMessage(
      {
        type: 'result',
        subtype: 'error_max_turns',
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      },
      CTX,
    );
    if (got[1]?.kind === 'turn_failed') {
      expect(got[1].reason).toBe('error_max_turns');
    } else {
      throw new Error('expected turn_failed');
    }
  });
});

describe('mapSdkMessage — defensive', () => {
  it('drops non-object inputs without throwing', () => {
    expect(mapSdkMessage(null, CTX)).toEqual([]);
    expect(mapSdkMessage(undefined, CTX)).toEqual([]);
    expect(mapSdkMessage('not an object', CTX)).toEqual([]);
    expect(mapSdkMessage(42, CTX)).toEqual([]);
  });

  it('drops messages with unknown top-level type', () => {
    expect(mapSdkMessage({ type: 'unknown_future_thing', payload: 1 }, CTX)).toEqual([]);
  });

  it('drops partial_assistant streaming deltas (would duplicate eventual full message)', () => {
    expect(mapSdkMessage({ type: 'partial_assistant', message: { content: [] } }, CTX)).toEqual([]);
  });
});
