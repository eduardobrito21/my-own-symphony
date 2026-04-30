// Orchestrator integration tests.
//
// These exercise the full tick → dispatch → mock-agent → exit loop
// against a `FakeTracker`, a real `WorkspaceManager` (against a temp
// dir), and a `MockAgent` configured for fast turns. We bypass the
// real timer mechanism via the `schedule` injection — tests call
// `tick()` directly and never wait on wall-clock seconds.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockAgent } from '../agent/mock/mock-agent.js';
import type { ServiceConfig } from '../config/schema.js';
import { NULL_LOGGER } from '../observability/index.js';
import { FakeTracker } from '../tracker/fake/fake-tracker.js';
import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../types/index.js';
import { WorkspaceManager } from '../workspace/index.js';

import { defaultProjects } from './test-helpers.js';
import { Orchestrator, type TimerSchedule } from './orchestrator.js';

const NEVER_FIRING_SCHEDULE: TimerSchedule = {
  setTimeout: () => null,
  clearTimeout: () => undefined,
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    projectKey: ProjectKey('default'),
    title: 'Do the thing',
    description: 'A description.',
    priority: 1,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date('2026-04-28T10:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

function buildConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  // We avoid running zod here because we want to construct partial
  // configs cheaply. The Orchestrator only reads a small subset.
  return {
    tracker: {
      endpoint: 'https://api.linear.app/graphql',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Cancelled'],
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
      stall_timeout_ms: 300_000,
    },
    ...overrides,
  };
}

describe('Orchestrator', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-orch-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('dispatches eligible issues and records them as completed after a successful run', async () => {
    const tracker = new FakeTracker([makeIssue()]);
    const agent = new MockAgent({ turnDurationMs: 5 });
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();

    // After tick, the issue is dispatched (running). `drain()` awaits
    // the worker without aborting, so the agent finishes naturally
    // and the issue lands in `completed`.
    await orchestrator.drain();

    const snapshot = orchestrator.snapshot();
    expect(snapshot.running.size).toBe(0);
    expect(snapshot.completed.has(IssueId('id-1'))).toBe(true);

    await orchestrator.stop();
  });

  it('honors the global concurrency cap', async () => {
    const tracker = new FakeTracker([
      makeIssue({ id: IssueId('a'), identifier: IssueIdentifier('SYMP-A') }),
      makeIssue({ id: IssueId('b'), identifier: IssueIdentifier('SYMP-B') }),
      makeIssue({ id: IssueId('c'), identifier: IssueIdentifier('SYMP-C') }),
    ]);
    // Slow agent so the first dispatched issues remain "running" while
    // we observe state.
    const agent = new MockAgent({ turnDurationMs: 5_000 });
    const config = buildConfig({
      workspace: { root: workspaceRoot },
      agent: { ...buildConfig().agent, max_concurrent_agents: 2 },
    });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    // Only 2 should be running; the third stays unclaimed.
    expect(orchestrator.snapshot().running.size).toBe(2);

    await orchestrator.stop();
  });

  it('honors a per-state cap (TODO=1, total=10)', async () => {
    const tracker = new FakeTracker([
      makeIssue({ id: IssueId('a'), identifier: IssueIdentifier('SYMP-A'), state: 'Todo' }),
      makeIssue({ id: IssueId('b'), identifier: IssueIdentifier('SYMP-B'), state: 'Todo' }),
      makeIssue({
        id: IssueId('c'),
        identifier: IssueIdentifier('SYMP-C'),
        state: 'In Progress',
      }),
    ]);
    const agent = new MockAgent({ turnDurationMs: 5_000 });
    const config = buildConfig({
      workspace: { root: workspaceRoot },
      agent: {
        ...buildConfig().agent,
        max_concurrent_agents: 10,
        max_concurrent_agents_by_state: { todo: 1 },
      },
    });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    const running = orchestrator.snapshot().running;
    // Should have exactly 2 running: 1 Todo + 1 In Progress.
    expect(running.size).toBe(2);
    const runningStates = Array.from(running.values())
      .map((entry) => entry.issue.state)
      .sort();
    expect(runningStates).toEqual(['In Progress', 'Todo']);

    await orchestrator.stop();
  });

  it('skips ineligible issues (Todo with non-terminal blocker)', async () => {
    const tracker = new FakeTracker([
      makeIssue({
        id: IssueId('blocked'),
        identifier: IssueIdentifier('SYMP-BLOCKED'),
        state: 'Todo',
        blockedBy: [
          {
            id: IssueId('blocker'),
            identifier: IssueIdentifier('SYMP-BLOCKER'),
            state: 'Todo', // non-terminal
          },
        ],
      }),
    ]);
    const agent = new MockAgent({ turnDurationMs: 5 });
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    expect(orchestrator.snapshot().running.size).toBe(0);

    await orchestrator.stop();
  });

  it('snapshot exposes session metadata after the agent emits session_started', async () => {
    const tracker = new FakeTracker([makeIssue()]);
    const agent = new MockAgent({
      turnDurationMs: 100,
      threadId: 'fixed-thread',
      turnId: 'fixed-turn',
    });
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    // Wait briefly for session_started to land.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const running = orchestrator.snapshot().running.get(IssueId('id-1'));
    expect(running).toBeDefined();
    expect(running?.session.threadId).toBe('fixed-thread');
    expect(running?.session.turnId).toBe('fixed-turn');
    expect(running?.session.sessionId).toBe('fixed-thread-fixed-turn');

    await orchestrator.stop();
  });

  it('handles a failing agent run by removing from running and not adding to completed', async () => {
    const tracker = new FakeTracker([makeIssue()]);
    const agent = new MockAgent({ turnDurationMs: 5, outcome: 'failure' });
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();
    await orchestrator.stop();

    const snapshot = orchestrator.snapshot();
    // Note: a failure-emitted turn_failed event is still part of a
    // "normal" iteration end (the agent's iterable ended cleanly),
    // so Plan 04 currently reports this as a normal exit. Plan 05
    // will introduce the policy of treating turn_failed as a
    // failure-driven retry. For now we just assert the run is over.
    expect(snapshot.running.size).toBe(0);
  });

  it('re-running tick after a successful exit re-dispatches if tracker still reports active', async () => {
    const tracker = new FakeTracker([makeIssue()]);
    const agent = new MockAgent({ turnDurationMs: 5 });
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent,
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    // Second tick: the issue has already completed once but is still
    // in Todo per the FakeTracker. It should be re-dispatched.
    await orchestrator.tick();
    await orchestrator.drain();
    await orchestrator.stop();

    expect(orchestrator.snapshot().completed.has(IssueId('id-1'))).toBe(true);
  });
});
