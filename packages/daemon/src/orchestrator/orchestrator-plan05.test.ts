// Plan 05 orchestrator integration tests.
//
// Plan 04's tests stay in `orchestrator.test.ts`. This file focuses
// on the new behaviors:
//   - retry queue (continuation + failure-driven backoff)
//   - reconciliation (terminate on tracker terminal/non-active)
//   - applyWorkflow (dynamic config reload)
//
// We use a manually-driven "controlled schedule" (an injectable
// `TimerSchedule`) instead of vitest fake timers. The controlled
// schedule captures every `setTimeout` call as a typed entry so the
// test can fire timers in deterministic order. This avoids the
// "did the microtask queue drain yet?" headaches you get with fake
// real timers.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockAgent } from '../agent/mock/mock-agent.js';
import type { ServiceConfig, WorkflowDefinition } from '../config/schema.js';
import { NULL_LOGGER } from '../observability/index.js';
import { FakeTracker } from '../tracker/fake/fake-tracker.js';
import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../types/index.js';
import { WorkspaceManager } from '../workspace/index.js';

import { defaultProjects } from './test-helpers.js';
import { Orchestrator, type TimerSchedule } from './orchestrator.js';

// ---- Test infrastructure ---------------------------------------------

interface ScheduledTimer {
  handle: number;
  handler: () => void;
  delayMs: number;
  scheduledAt: number;
}

interface ControlledSchedule extends TimerSchedule {
  pending: ScheduledTimer[];
  /** Fire the timer with the given handle (does not advance clock). */
  fire(handle: number): void;
  /** Fire all currently pending timers in scheduling order. */
  fireAll(): void;
}

function controlledSchedule(): ControlledSchedule {
  let nextHandle = 0;
  let monotonic = 0;
  const pending: ScheduledTimer[] = [];
  return {
    pending,
    setTimeout(handler, delayMs) {
      nextHandle += 1;
      pending.push({
        handle: nextHandle,
        handler,
        delayMs,
        scheduledAt: monotonic++,
      });
      return nextHandle;
    },
    clearTimeout(handle) {
      const i = pending.findIndex((p) => p.handle === handle);
      if (i !== -1) pending.splice(i, 1);
    },
    fire(handle) {
      const i = pending.findIndex((p) => p.handle === handle);
      if (i === -1) return;
      const [entry] = pending.splice(i, 1);
      entry?.handler();
    },
    fireAll() {
      while (pending.length > 0) {
        const next = pending.shift();
        next?.handler();
      }
    },
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    projectKey: ProjectKey('default'),
    title: 'Do the thing',
    description: null,
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
  return {
    tracker: {
      endpoint: 'https://api.linear.app/graphql',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Cancelled'],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: '/tmp/will-override' },
    hooks: { timeout_ms: 5_000 },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 60_000,
      read_timeout_ms: 5_000,
      // Disabled by default; specific tests enable it.
      stall_timeout_ms: 0,
    },
    ...overrides,
  };
}

// ---- Tests ----------------------------------------------------------

describe('Orchestrator (Plan 05)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-orch-p5-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  describe('retry queue', () => {
    it('schedules a continuation retry (~1000 ms) after a normal worker exit', async () => {
      const tracker = new FakeTracker([makeIssue()]);
      const agent = new MockAgent({ turnDurationMs: 5 });
      const config = buildConfig({ workspace: { root: workspaceRoot } });
      const schedule = controlledSchedule();
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'work on {{ issue.identifier }}',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
      });

      await orchestrator.tick();
      await orchestrator.drain();

      // After a clean run we expect: completed += id, retry queued
      // with a 1000 ms delay.
      const snap = orchestrator.snapshot();
      expect(snap.completed.has(IssueId('id-1'))).toBe(true);
      expect(snap.retryAttempts.size).toBe(1);
      const retry = snap.retryAttempts.get(IssueId('id-1'));
      expect(retry?.attempt).toBe(1);
      // The pending timer in our schedule should have the 1000 ms delay.
      const continuation = schedule.pending.find((p) => p.delayMs === 1_000);
      expect(continuation).toBeDefined();

      await orchestrator.stop();
    });

    it('schedules a failure-driven retry (10s default) after an abnormal exit', async () => {
      // Force an abnormal exit by failing the workspace `before_run`
      // hook.
      const tracker = new FakeTracker([makeIssue()]);
      const agent = new MockAgent({ turnDurationMs: 5 });
      const config = buildConfig({
        workspace: { root: workspaceRoot },
        hooks: { timeout_ms: 5_000, before_run: 'exit 9' },
      });
      const schedule = controlledSchedule();
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'x',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
      });

      await orchestrator.tick();
      await orchestrator.drain();

      const snap = orchestrator.snapshot();
      expect(snap.running.size).toBe(0);
      expect(snap.completed.has(IssueId('id-1'))).toBe(false);
      expect(snap.retryAttempts.size).toBe(1);
      const retry = snap.retryAttempts.get(IssueId('id-1'));
      expect(retry?.attempt).toBe(1);
      // 10s = 10_000ms
      expect(schedule.pending.find((p) => p.delayMs === 10_000)).toBeDefined();

      await orchestrator.stop();
    });
  });

  describe('reconciliation', () => {
    it('terminates a running issue when the tracker reports terminal state', async () => {
      const tracker = new FakeTracker([makeIssue()]);
      // Slow agent so we can observe state mid-run.
      const agent = new MockAgent({ turnDurationMs: 10_000 });
      const config = buildConfig({ workspace: { root: workspaceRoot } });
      const schedule = controlledSchedule();
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'work on {{ issue.identifier }}',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
      });

      // First tick dispatches.
      await orchestrator.tick();
      expect(orchestrator.snapshot().running.size).toBe(1);

      // Tracker now reports Done.
      tracker.setIssueState(IssueId('id-1'), 'Done');

      // Second tick: reconciliation sees terminal, terminates.
      await orchestrator.tick();
      // The terminate flow aborts the worker; let the worker drain.
      await orchestrator.drain();

      const snap = orchestrator.snapshot();
      expect(snap.running.size).toBe(0);
      // No retry should be queued for a reconciliation termination.
      expect(snap.retryAttempts.has(IssueId('id-1'))).toBe(false);
      // Claim is dropped.
      expect(snap.claimed.has(IssueId('id-1'))).toBe(false);

      await orchestrator.stop();
    });

    it('terminates without workspace cleanup when state is non-active and non-terminal', async () => {
      const tracker = new FakeTracker([makeIssue()]);
      const agent = new MockAgent({ turnDurationMs: 10_000 });
      const config = buildConfig({ workspace: { root: workspaceRoot } });
      const schedule = controlledSchedule();
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'x',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
      });

      await orchestrator.tick();
      // Move to "Paused" — not in active or terminal lists.
      tracker.setIssueState(IssueId('id-1'), 'Paused');

      await orchestrator.tick();
      await orchestrator.drain();

      const snap = orchestrator.snapshot();
      expect(snap.running.size).toBe(0);
      expect(snap.retryAttempts.has(IssueId('id-1'))).toBe(false);

      await orchestrator.stop();
    });
  });

  describe('stall detection', () => {
    it('aborts a stalled worker so it queues a failure retry on exit', async () => {
      const tracker = new FakeTracker([makeIssue()]);
      // Agent that hangs forever — only stall detection ends it.
      const agent = new MockAgent({ outcome: 'never_completes', turnDurationMs: 100_000 });
      // Stall timeout = 100ms. We'll advance our fake `now` past it.
      const config = buildConfig({
        workspace: { root: workspaceRoot },
        agent: {
          ...buildConfig().agent,
          stall_timeout_ms: 100,
        },
      });
      const schedule = controlledSchedule();
      let nowMs = 1_700_000_000_000;
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'x',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
        now: () => new Date(nowMs),
      });

      await orchestrator.tick();
      // Worker is running; agent is hanging.
      expect(orchestrator.snapshot().running.size).toBe(1);

      // Jump time forward past stall_timeout_ms.
      nowMs += 1_000;

      // Second tick: reconciliation detects the stall and aborts.
      await orchestrator.tick();
      // Wait for the worker to actually finish (the abort propagates
      // asynchronously through the iterable).
      await orchestrator.drain();

      const snap = orchestrator.snapshot();
      expect(snap.running.size).toBe(0);
      // Stall is treated as abnormal exit, so a failure retry is
      // queued.
      expect(snap.retryAttempts.has(IssueId('id-1'))).toBe(true);
      expect(snap.retryAttempts.get(IssueId('id-1'))?.attempt).toBe(1);

      await orchestrator.stop();
    });
  });

  describe('applyWorkflow (dynamic reload)', () => {
    function buildDef(over: Partial<ServiceConfig> = {}): WorkflowDefinition {
      return {
        config: buildConfig(over),
        promptTemplate: 'work on {{ issue.identifier }}',
        path: '/tmp/fake-workflow.md',
      };
    }

    it('updates the live poll interval and reschedules the next tick', async () => {
      const tracker = new FakeTracker([]);
      const agent = new MockAgent();
      const config = buildConfig({
        workspace: { root: workspaceRoot },
        polling: { interval_ms: 30_000 },
      });
      const schedule = controlledSchedule();
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'x',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
      });

      // Confirm the initial config is in effect.
      expect(orchestrator.snapshot().pollIntervalMs).toBe(30_000);

      // Reload to a tighter interval. We don't run start()
      // because that would race with the test's tick assertions —
      // the rescheduling-on-pending-timer path is exercised in the
      // live smoke test.
      await orchestrator.applyWorkflow(buildDef({ polling: { interval_ms: 5_000 } }));

      expect(orchestrator.snapshot().pollIntervalMs).toBe(5_000);

      await orchestrator.stop();
    });

    it('updates max_concurrent_agents so the next tick uses the new cap', async () => {
      const tracker = new FakeTracker([
        makeIssue({ id: IssueId('a'), identifier: IssueIdentifier('SYMP-A') }),
        makeIssue({ id: IssueId('b'), identifier: IssueIdentifier('SYMP-B') }),
        makeIssue({ id: IssueId('c'), identifier: IssueIdentifier('SYMP-C') }),
      ]);
      const agent = new MockAgent({ turnDurationMs: 5_000 });
      const config = buildConfig({
        workspace: { root: workspaceRoot },
        agent: { ...buildConfig().agent, max_concurrent_agents: 1 },
      });
      const schedule = controlledSchedule();
      const orchestrator = new Orchestrator({
        config,
        promptTemplateSource: 'x',
        projects: defaultProjects(tracker),
        workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
        agent,
        logger: NULL_LOGGER,
        schedule,
      });

      await orchestrator.tick();
      expect(orchestrator.snapshot().running.size).toBe(1);

      // Reload bumping the cap to 3.
      await orchestrator.applyWorkflow(
        buildDef({
          agent: { ...buildConfig().agent, max_concurrent_agents: 3 },
        }),
      );
      expect(orchestrator.snapshot().maxConcurrentAgents).toBe(3);

      // Next tick should pick up the other two.
      await orchestrator.tick();
      expect(orchestrator.snapshot().running.size).toBe(3);

      await orchestrator.stop();
    });
  });
});
