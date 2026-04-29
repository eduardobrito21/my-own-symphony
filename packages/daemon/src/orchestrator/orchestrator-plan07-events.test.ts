// Plan 07 — orchestrator handling of new AgentEvent kinds.
//
// The Claude Agent SDK emits richer event types than MockAgent does,
// notably tool calls, tool results, and per-turn token usage. This
// file exercises the orchestrator's response to those events
// independently of any real SDK by driving it with a hand-crafted
// `AgentRunner` stub that yields exactly the event sequence we want
// to test.
//
// Why a stub instead of extending MockAgent: keeping MockAgent
// focused on its "fake codex turns" role keeps Plan 04's intent
// intact. New behaviors get their own targeted stub. If a third
// runner ever needs the same trick we can extract a shared helper.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent, AgentRunInput, AgentRunner } from '../agent/runner.js';
import type { ServiceConfig } from '../config/schema.js';
import { NULL_LOGGER } from '../observability/index.js';
import { FakeTracker } from '../tracker/fake/fake-tracker.js';
import { IssueId, IssueIdentifier, SessionId, type Issue } from '../types/index.js';
import { WorkspaceManager } from '../workspace/index.js';

import { Orchestrator, type TimerSchedule } from './orchestrator.js';

const NEVER_FIRING_SCHEDULE: TimerSchedule = {
  setTimeout: () => null,
  clearTimeout: () => undefined,
};

interface ScheduledTimer {
  handle: number;
  handler: () => void;
  delayMs: number;
}

interface ControlledSchedule extends TimerSchedule {
  pending: ScheduledTimer[];
}

/** Captures setTimeout calls so a test can inspect retry delays. */
function controlledSchedule(): ControlledSchedule {
  let nextHandle = 0;
  const pending: ScheduledTimer[] = [];
  return {
    pending,
    setTimeout(handler, delayMs) {
      nextHandle += 1;
      pending.push({ handle: nextHandle, handler, delayMs });
      return nextHandle;
    },
    clearTimeout(handle) {
      const i = pending.findIndex((p) => p.handle === handle);
      if (i !== -1) pending.splice(i, 1);
    },
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-evt'),
    identifier: IssueIdentifier('SYMP-EVT'),
    title: 'Event-test issue',
    description: null,
    priority: null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date('2026-04-29T10:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

function buildConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    tracker: {
      endpoint: 'https://api.linear.app/graphql',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: '/tmp/will-be-overridden' },
    hooks: { timeout_ms: 5_000 },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 60_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 0,
    },
    ...overrides,
  };
}

/**
 * Drive the orchestrator with a fixed event sequence. Each event
 * is yielded with a `setImmediate` boundary so the orchestrator's
 * lock has a chance to reach quiescence between events — closer to
 * real-world async iteration than a tight synchronous loop.
 */
class ScriptedAgent implements AgentRunner {
  constructor(private readonly events: readonly AgentEvent[]) {}

  async *run(_input: AgentRunInput): AsyncIterable<AgentEvent> {
    for (const event of this.events) {
      // Yield a microtask so the consumer can interleave.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      yield event;
    }
  }
}

const AT = new Date('2026-04-29T10:00:01Z');

const SESSION_STARTED: AgentEvent = {
  kind: 'session_started',
  sessionId: SessionId('thread-evt-turn-1'),
  threadId: 'thread-evt',
  turnId: 'turn-1',
  at: AT,
};

const TURN_COMPLETED: AgentEvent = {
  kind: 'turn_completed',
  turnNumber: 1,
  at: AT,
};

describe('Orchestrator — Plan 07 event handling', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-orch-evt-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function buildOrch(
    events: readonly AgentEvent[],
    options: {
      readonly issue?: Issue;
      readonly schedule?: TimerSchedule;
    } = {},
  ): Orchestrator {
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    return new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      tracker: new FakeTracker([options.issue ?? makeIssue()]),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new ScriptedAgent(events),
      logger: NULL_LOGGER,
      schedule: options.schedule ?? NEVER_FIRING_SCHEDULE,
    });
  }

  it('records a tool_call as the latest agent message', async () => {
    const events: AgentEvent[] = [
      SESSION_STARTED,
      {
        kind: 'tool_call',
        callId: 'call-001',
        toolName: 'mcp__linear__linear_graphql',
        input: { query: '{ viewer { id } }' },
        at: AT,
      },
      TURN_COMPLETED,
    ];

    const orchestrator = buildOrch(events);
    await orchestrator.tick();
    // Snapshot while the worker is mid-flight, before drain
    // collapses the running entry into completed.
    const running = await waitForLastEvent(orchestrator, 'tool_call');
    expect(running.session.lastAgentMessage).toBe('calling mcp__linear__linear_graphql');

    await orchestrator.drain();
    await orchestrator.stop();
  });

  it('records a successful tool_result with its callId', async () => {
    const events: AgentEvent[] = [
      SESSION_STARTED,
      {
        kind: 'tool_call',
        callId: 'call-007',
        toolName: 'mcp__linear__linear_graphql',
        input: { query: '{ viewer { id } }' },
        at: AT,
      },
      {
        kind: 'tool_result',
        callId: 'call-007',
        isError: false,
        content: '{"data":{"viewer":{"id":"u-1"}}}',
        at: AT,
      },
      TURN_COMPLETED,
    ];

    const orchestrator = buildOrch(events);
    await orchestrator.tick();
    const running = await waitForLastEvent(orchestrator, 'tool_result');
    expect(running.session.lastAgentMessage).toBe('tool returned (call call-007)');

    await orchestrator.drain();
    await orchestrator.stop();
  });

  it('records a failing tool_result distinctly from a successful one', async () => {
    const events: AgentEvent[] = [
      SESSION_STARTED,
      {
        kind: 'tool_call',
        callId: 'call-bad',
        toolName: 'mcp__linear__linear_graphql',
        input: { query: 'malformed' },
        at: AT,
      },
      {
        kind: 'tool_result',
        callId: 'call-bad',
        isError: true,
        content: 'GraphQL parse error',
        at: AT,
      },
      TURN_COMPLETED,
    ];

    const orchestrator = buildOrch(events);
    await orchestrator.tick();
    const running = await waitForLastEvent(orchestrator, 'tool_result');
    expect(running.session.lastAgentMessage).toBe('tool error (call call-bad)');

    await orchestrator.drain();
    await orchestrator.stop();
  });

  it('accumulates per-turn usage into both session and daemon totals', async () => {
    const events: AgentEvent[] = [
      SESSION_STARTED,
      {
        kind: 'usage',
        inputTokens: 1500,
        outputTokens: 200,
        cacheCreationInputTokens: 800,
        cacheReadInputTokens: 700,
        totalCostUsd: 0.0123,
        at: AT,
      },
      TURN_COMPLETED,
    ];

    const orchestrator = buildOrch(events);
    await orchestrator.tick();

    const running = await waitForLastEvent(orchestrator, 'usage');
    expect(running.session.tokens.inputTokens).toBe(1500);
    expect(running.session.tokens.outputTokens).toBe(200);
    expect(running.session.tokens.totalTokens).toBe(1700);

    const snapshot = orchestrator.snapshot();
    expect(snapshot.agentTotals.inputTokens).toBe(1500);
    expect(snapshot.agentTotals.outputTokens).toBe(200);
    expect(snapshot.agentTotals.totalTokens).toBe(1700);

    await orchestrator.drain();
    await orchestrator.stop();
  });

  it('treats a turn_failed event as an abnormal exit (failure-driven retry, NOT continuation)', async () => {
    // Bug 1 from the Plan 07 smoke run (2026-04-29): the agent yielded
    // a `turn_failed` event after Anthropic returned a "Credit balance
    // is too low" error, but the worker treated the run as a normal
    // exit and scheduled a 1s continuation retry — effectively a tight
    // loop on persistent failures. The orchestrator must inspect the
    // last terminal event and route to the failure-driven retry path.
    const events: AgentEvent[] = [
      SESSION_STARTED,
      {
        kind: 'turn_failed',
        reason: 'Credit balance is too low',
        at: AT,
      },
    ];

    const schedule = controlledSchedule();
    const orchestrator = buildOrch(events, { schedule });
    await orchestrator.tick();
    await orchestrator.drain();

    const snap = orchestrator.snapshot();
    // Failure path: NOT added to `completed`, retry queue has one
    // entry with the failure-tier delay (10s = first failure backoff).
    expect(snap.completed.has(IssueId('id-evt'))).toBe(false);
    expect(snap.retryAttempts.size).toBe(1);
    const retry = snap.retryAttempts.get(IssueId('id-evt'));
    expect(retry?.attempt).toBe(1);

    // Retry delay should be 10s (failure tier first try). The
    // continuation tier is 1s — the bug surfaced because continuation
    // was getting picked even on `turn_failed`.
    const failureDelay = schedule.pending.find((p) => p.delayMs === 10_000);
    const continuationDelay = schedule.pending.find((p) => p.delayMs === 1_000);
    expect(failureDelay).toBeDefined();
    expect(continuationDelay).toBeUndefined();

    await orchestrator.stop();
  });

  it('still treats a turn_completed exit as a continuation retry (regression guard)', async () => {
    // Belt-and-suspenders for the fix above: a clean
    // `turn_completed` must NOT be misclassified as failure.
    const schedule = controlledSchedule();
    const orchestrator = buildOrch([SESSION_STARTED, TURN_COMPLETED], { schedule });
    await orchestrator.tick();
    await orchestrator.drain();

    const snap = orchestrator.snapshot();
    expect(snap.completed.has(IssueId('id-evt'))).toBe(true);
    expect(snap.retryAttempts.size).toBe(1);
    expect(schedule.pending.find((p) => p.delayMs === 1_000)).toBeDefined();
    expect(schedule.pending.find((p) => p.delayMs === 10_000)).toBeUndefined();

    await orchestrator.stop();
  });

  it('sums multiple usage events within one turn (per-turn semantics, no diffing)', async () => {
    // Belt-and-suspenders: the SDK is documented as per-turn, but if
    // it ever emits more than one usage event in a turn we want them
    // to add, not to silently overwrite. Pin that semantic.
    const events: AgentEvent[] = [
      SESSION_STARTED,
      {
        kind: 'usage',
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        totalCostUsd: null,
        at: AT,
      },
      {
        kind: 'usage',
        inputTokens: 50,
        outputTokens: 5,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        totalCostUsd: null,
        at: AT,
      },
      TURN_COMPLETED,
    ];

    const orchestrator = buildOrch(events);
    await orchestrator.tick();
    await orchestrator.drain();

    const snapshot = orchestrator.snapshot();
    expect(snapshot.agentTotals.inputTokens).toBe(150);
    expect(snapshot.agentTotals.outputTokens).toBe(15);
    expect(snapshot.agentTotals.totalTokens).toBe(165);

    await orchestrator.stop();
  });
});

// ---------------------------------------------------------------------
// Test helper — small poll so we can observe state mid-run without
// racing the worker loop. Polls until `lastAgentEvent === kind`,
// then returns the running entry. Throws after ~200 microtasks.

async function waitForLastEvent(orch: Orchestrator, kind: string) {
  for (let i = 0; i < 200; i += 1) {
    const snap = orch.snapshot();
    const entry = snap.running.get(IssueId('id-evt'));
    if (entry?.session.lastAgentEvent === kind) {
      return entry;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for lastAgentEvent === ${kind}`);
}
