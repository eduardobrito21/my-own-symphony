// Unit tests for `ClaudeAgent`.
//
// We inject a stub `query` function so we never touch the real SDK
// (no network, no API key needed). The stub returns an async
// generator we control, plus a `close()` method like the real one.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NULL_LOGGER } from '../../observability/index.js';
import type { LinearClient } from '../../tracker/linear/client.js';
import { IssueId, IssueIdentifier } from '../../types/index.js';
import type { AgentEvent, AgentRunInput } from '../runner.js';

import { ClaudeAgent, type QueryFn } from './agent.js';
import { sessionPathFor } from './session-store.js';

const SKILL = '# Symphony skill (test fixture)\n';

function makeInput(workspacePath: string, attempt: number | null = null): AgentRunInput {
  return {
    issueId: IssueId('id-claude-1'),
    issueIdentifier: IssueIdentifier('EDU-99'),
    workspacePath,
    prompt: 'test prompt',
    attempt,
  };
}

function dummyClient(): LinearClient {
  return { execute: vi.fn() } as unknown as LinearClient;
}

/**
 * Build a stub `query` whose return value satisfies the SDK's `Query`
 * shape: an AsyncGenerator with a `close()` method. The messages
 * array is yielded one-by-one; an optional `throwOn` index makes the
 * iteration throw at that step (used to test mid-stream failure).
 */
function makeStubQuery(args: {
  messages: readonly unknown[];
  throwOn?: number;
  onCalled?: (params: Parameters<QueryFn>[0]) => void;
}): QueryFn {
  return (params) => {
    args.onCalled?.(params);
    let i = 0;
    // We deliberately avoid `async` on the stub iterator methods to
    // keep eslint's `require-await` rule happy. The real SDK returns
    // Promises from these methods too; `for await` only cares that
    // the return value is thenable.
    const gen: AsyncGenerator<unknown, void, unknown> = {
      next() {
        if (args.throwOn !== undefined && i === args.throwOn) {
          return Promise.reject(new Error('stub-stream-failure'));
        }
        if (i >= args.messages.length) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const value = args.messages[i];
        i += 1;
        return Promise.resolve({ done: false, value });
      },
      return() {
        return Promise.resolve({ done: true, value: undefined });
      },
      throw(err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    // SDK Query has close() — we add it. The cast is safe because
    // ClaudeAgent only uses `for await` + `close()`.
    const query = Object.assign(gen, { close: vi.fn() });
    return query as unknown as Query;
  };
}

const SUCCESS_TURN: readonly unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'sess-A' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 100, output_tokens: 10 },
    total_cost_usd: 0.001,
    session_id: 'sess-A',
  },
];

describe('ClaudeAgent — basic flow', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'symphony-claude-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('yields mapped AgentEvents in order', async () => {
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({ messages: SUCCESS_TURN }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run(makeInput(workspace))) {
      events.push(event);
    }

    expect(events.map((e) => e.kind)).toEqual([
      'session_started',
      'notification',
      'usage',
      'turn_completed',
    ]);
  });

  it('persists the observed session_id to <workspace>/.symphony/session.json', async () => {
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({ messages: SUCCESS_TURN }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    for await (const _ of agent.run(makeInput(workspace))) {
      /* drain */
    }

    const path = sessionPathFor(workspace);
    const stats = await stat(path);
    expect(stats.isFile()).toBe(true);
    const raw = await readFile(path, 'utf8');
    const record = JSON.parse(raw) as { sessionId: string; model: string };
    expect(record.sessionId).toBe('sess-A');
    expect(record.model).toBe('claude-haiku-4-5');
  });

  it('uses resume option when a session.json exists', async () => {
    // Pre-populate session.json by running once.
    const first = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({ messages: SUCCESS_TURN }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });
    for await (const _ of first.run(makeInput(workspace))) {
      /* drain */
    }

    let observedOptions: unknown;
    const second = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN,
        onCalled: (params) => {
          observedOptions = params.options;
        },
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });
    for await (const _ of second.run(makeInput(workspace, 1))) {
      /* drain */
    }

    expect((observedOptions as { resume?: string }).resume).toBe('sess-A');
  });

  it('falls back to a fresh session if resume throws synchronously', async () => {
    // Pre-populate session.json.
    const first = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({ messages: SUCCESS_TURN }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });
    for await (const _ of first.run(makeInput(workspace))) {
      /* drain */
    }

    // Build a queryFn that throws on the first call (resume),
    // succeeds on the second (fresh).
    let calls = 0;
    const queryFn: QueryFn = (params) => {
      calls += 1;
      if (calls === 1) {
        // Verify this call had `resume` set.
        expect((params.options as { resume?: string } | undefined)?.resume).toBe('sess-A');
        throw new Error('session expired');
      }
      // Second call: should be fresh (no resume).
      expect((params.options as { resume?: string } | undefined)?.resume).toBeUndefined();
      return makeStubQuery({ messages: SUCCESS_TURN })(params);
    };

    const second = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn,
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const events: AgentEvent[] = [];
    for await (const event of second.run(makeInput(workspace, 1))) {
      events.push(event);
    }
    expect(calls).toBe(2);
    // The fallback run should produce a normal event sequence.
    expect(events.at(-1)?.kind).toBe('turn_completed');
  });

  it('falls back to a fresh session when resume fails with a result-error + post-throw (Bug 4)', async () => {
    // Smoke run #3 reproduction (2026-04-29): the SDK rejected a
    // resume because the session id wasn't in its store. It emitted
    // a `result subtype=error_*` (mapped to `usage` + `turn_failed`)
    // and then threw "No conversation found with session ID: …".
    // The catch's previous `!yieldedAny` check was tripped by the
    // zero-token usage event, so we never fell back to fresh and
    // every retry burned an SDK call. The fix uses
    // `observedSessionId === null` (no `system: init` ever
    // arrived) as the resume-failure signal.

    // Pre-populate session.json so resume gets attempted.
    const first = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({ messages: SUCCESS_TURN }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });
    for await (const _ of first.run(makeInput(workspace))) {
      /* drain */
    }

    // Reproduce the failed-resume stream shape: error result THEN
    // throw, with NO `system: init` ever emitted.
    const resume_rejected: readonly unknown[] = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
        session_id: 'sess-A',
      },
    ];

    let calls = 0;
    const queryFn: QueryFn = (params) => {
      calls += 1;
      if (calls === 1) {
        expect((params.options as { resume?: string } | undefined)?.resume).toBe('sess-A');
        return makeStubQuery({
          messages: resume_rejected,
          throwOn: 1,
        })(params);
      }
      // Second call: fallback to fresh (no resume).
      expect((params.options as { resume?: string } | undefined)?.resume).toBeUndefined();
      return makeStubQuery({ messages: SUCCESS_TURN })(params);
    };

    const second = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn,
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const events: AgentEvent[] = [];
    for await (const event of second.run(makeInput(workspace, 1))) {
      events.push(event);
    }

    // Two SDK calls: the failed resume and the fresh fallback.
    expect(calls).toBe(2);
    // Final terminal must be the SUCCESS from the fresh run, not
    // the turn_failed from the rejected resume.
    expect(events.at(-1)?.kind).toBe('turn_completed');
    // And we must not have leaked the resume-failure terminal to
    // the consumer.
    const failedTerminals = events.filter((e) => e.kind === 'turn_failed');
    expect(failedTerminals).toHaveLength(0);
  });

  it('reclassifies a buffered turn_completed as turn_failed when the SDK throws after the result (Bug 2)', async () => {
    // Smoke-run reproduction (2026-04-29): the SDK yielded a
    // `result subtype=success` with empty usage when Anthropic's
    // credits were exhausted, then the underlying CLI exited
    // nonzero and surfaced as a thrown error. Without the fix, the
    // ClaudeAgent emitted turn_completed AND turn_failed —
    // violating the SPEC's exactly-one-terminal contract — and the
    // orchestrator scheduled a fast continuation retry.
    const credit_exhausted_then_throw: readonly unknown[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-X' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Credit balance is too low' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
        session_id: 'sess-X',
      },
    ];

    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: credit_exhausted_then_throw,
        throwOn: 3, // throw after the result message
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run(makeInput(workspace))) {
      events.push(event);
    }

    // Exactly one terminal — turn_failed (NOT turn_completed,
    // because the throw is the more authoritative signal).
    const terminals = events.filter((e) => e.kind === 'turn_completed' || e.kind === 'turn_failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe('turn_failed');
  });

  it('emits the buffered turn_completed when the SDK closes cleanly (regression for Bug 2 fix)', async () => {
    // Belt-and-suspenders: the buffering must NOT lose the terminal
    // on a normal happy-path run. If we drop into the `aborted` /
    // `needsRetryWithoutResume` paths or never yield, that's a bug.
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({ messages: SUCCESS_TURN }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run(makeInput(workspace))) {
      events.push(event);
    }
    expect(events.at(-1)?.kind).toBe('turn_completed');
    // And only one terminal:
    expect(
      events.filter((e) => e.kind === 'turn_completed' || e.kind === 'turn_failed'),
    ).toHaveLength(1);
  });

  it('emits a synthetic turn_failed if the SDK fails after yielding events', async () => {
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN.slice(0, 2), // init + assistant
        throwOn: 2, // throw before result
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run(makeInput(workspace))) {
      events.push(event);
    }
    // We yielded session_started + notification before the throw,
    // so the runner should NOT retry — instead emit turn_failed.
    expect(events.at(-1)?.kind).toBe('turn_failed');
  });

  it('respects an already-aborted signal (still runs the SDK; abort propagates via controller)', async () => {
    const ac = new AbortController();
    ac.abort();

    let observedSignal: AbortController | undefined;
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN,
        onCalled: (params) => {
          observedSignal = (params.options as { abortController?: AbortController } | undefined)
            ?.abortController;
        },
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    const input: AgentRunInput = { ...makeInput(workspace), signal: ac.signal };
    for await (const _ of agent.run(input)) {
      /* drain */
    }

    expect(observedSignal?.signal.aborted).toBe(true);
  });

  it('passes the workspace path as cwd and the skill markdown as systemPrompt', async () => {
    let observedOptions: { cwd?: string; systemPrompt?: string } | undefined;
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN,
        onCalled: (params) => {
          observedOptions = params.options as typeof observedOptions;
        },
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    for await (const _ of agent.run(makeInput(workspace))) {
      /* drain */
    }
    expect(observedOptions?.cwd).toBe(workspace);
    expect(observedOptions?.systemPrompt).toBe(SKILL);
  });

  it('passes cost and turn controls to the SDK', async () => {
    let observedOptions: Record<string, unknown> | undefined;
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      thinking: { type: 'disabled' },
      maxModelRoundTrips: 3,
      maxBudgetUsd: 0.02,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN,
        onCalled: (params) => {
          observedOptions = params.options;
        },
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    for await (const _ of agent.run(makeInput(workspace))) {
      /* drain */
    }

    expect(observedOptions?.['thinking']).toEqual({ type: 'disabled' });
    expect(observedOptions?.['maxTurns']).toBe(3);
    expect(observedOptions?.['maxBudgetUsd']).toBe(0.02);
  });

  it('does NOT pass persistSession: false (Bug 3 — would break SDK resume)', async () => {
    // Smoke run #2 (2026-04-29) showed every retry-with-resume
    // failing with "No conversation found with session ID: …"
    // because we were passing `persistSession: false`. The SDK's
    // `resume:` option looks the session up in its own
    // ~/.claude/projects/ store; disabling persistence makes
    // resume permanently impossible. Pin that we never regress
    // back to the old behavior.
    let observedOptions: Record<string, unknown> | undefined;
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN,
        onCalled: (params) => {
          observedOptions = params.options;
        },
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    for await (const _ of agent.run(makeInput(workspace))) {
      /* drain */
    }

    // We accept either `true` or undefined (SDK default). What we
    // MUST NOT do is set it to `false`.
    expect(observedOptions?.['persistSession']).not.toBe(false);
  });

  it('registers the linear MCP server and allows the qualified tool name', async () => {
    let observedOptions:
      | {
          mcpServers?: Record<string, unknown>;
          allowedTools?: readonly string[];
          tools?: unknown;
        }
      | undefined;
    const agent = new ClaudeAgent({
      linearClient: dummyClient(),
      skillMarkdown: SKILL,
      logger: NULL_LOGGER,
      queryFn: makeStubQuery({
        messages: SUCCESS_TURN,
        onCalled: (params) => {
          observedOptions = params.options;
        },
      }),
      now: () => new Date('2026-04-29T10:00:00Z'),
    });

    for await (const _ of agent.run(makeInput(workspace))) {
      /* drain */
    }
    expect(Object.keys(observedOptions?.mcpServers ?? {})).toContain('linear');
    expect(observedOptions?.tools).toEqual([]);
    expect(observedOptions?.allowedTools).toContain('mcp__linear__linear_graphql');
  });
});
