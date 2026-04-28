import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier } from '../../types/index.js';
import type { AgentEvent, AgentRunInput } from '../runner.js';

import { MockAgent } from './mock-agent.js';

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    issueId: IssueId('id-1'),
    issueIdentifier: IssueIdentifier('SYMP-1'),
    workspacePath: '/tmp/ws',
    prompt: 'do the thing',
    attempt: null,
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('MockAgent', () => {
  it('emits session_started -> turn_completed for the default success outcome', async () => {
    const agent = new MockAgent({ turnDurationMs: 0 });
    const events = await collect(agent.run(input()));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['session_started', 'turn_completed']);
  });

  it('emits notifications between session_started and the terminal event', async () => {
    const agent = new MockAgent({
      turnDurationMs: 0,
      notifications: ['analyzing', 'planning'],
    });
    const events = await collect(agent.run(input()));
    expect(events.map((e) => e.kind)).toEqual([
      'session_started',
      'notification',
      'notification',
      'turn_completed',
    ]);
    const messages = events
      .filter((e): e is Extract<AgentEvent, { kind: 'notification' }> => e.kind === 'notification')
      .map((e) => e.message);
    expect(messages).toEqual(['analyzing', 'planning']);
  });

  it('emits turn_failed for the failure outcome', async () => {
    const agent = new MockAgent({ turnDurationMs: 0, outcome: 'failure' });
    const events = await collect(agent.run(input()));
    const last = events.at(-1);
    expect(last?.kind).toBe('turn_failed');
  });

  it('honors threadId / turnId overrides for deterministic session IDs', async () => {
    const agent = new MockAgent({
      turnDurationMs: 0,
      threadId: 'fixed-thread',
      turnId: 'fixed-turn',
    });
    const events = await collect(agent.run(input()));
    const start = events[0];
    expect(start?.kind).toBe('session_started');
    if (start?.kind === 'session_started') {
      expect(start.threadId).toBe('fixed-thread');
      expect(start.turnId).toBe('fixed-turn');
      expect(start.sessionId).toBe('fixed-thread-fixed-turn');
    }
  });

  it('respects an AbortSignal when configured for never_completes', async () => {
    const agent = new MockAgent({ turnDurationMs: 1000, outcome: 'never_completes' });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 20);
    const events: AgentEvent[] = [];
    try {
      for await (const e of agent.run(input({ signal: ac.signal }))) {
        events.push(e);
      }
    } catch {
      // Expected: aborted
    }
    // Should have emitted session_started before being aborted; should
    // NOT have emitted a turn_completed event.
    expect(events[0]?.kind).toBe('session_started');
    expect(events.some((e) => e.kind === 'turn_completed')).toBe(false);
  });
});
