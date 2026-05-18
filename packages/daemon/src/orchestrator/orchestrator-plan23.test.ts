// Plan 23 — deterministic Todo → In Progress transition at dispatch.
//
// These tests pin three properties:
//
//   1. The orchestrator calls `tracker.transitionIssueState` exactly
//      once per eligible candidate, BEFORE the worker spawns, with
//      the project's configured `inProgressState`.
//   2. When the issue is already in `inProgressState`, the API call
//      is short-circuited (transitionCalls stays empty) — idempotent.
//   3. A failure result from `transitionIssueState` does NOT abort
//      dispatch. The pipeline still runs.

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
    id: IssueId('plan23-1'),
    identifier: IssueIdentifier('EDU-23'),
    projectKey: ProjectKey('default'),
    title: 'Plan 23 fixture',
    description: null,
    priority: null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
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

describe('Orchestrator — Plan 23 transition to in-progress at dispatch', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-plan23-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('calls transitionIssueState once per eligible candidate with the configured target state', async () => {
    const tracker = new FakeTracker([makeIssue({ state: 'Todo' })]);
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker, { inProgressState: 'In Progress' }),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    expect(tracker.transitionCalls).toHaveLength(1);
    expect(tracker.transitionCalls[0]).toMatchObject({
      issueId: 'plan23-1',
      targetStateName: 'In Progress',
    });
    // Side-effect: the fake actually mutated the state to match.
    expect(tracker.getIssue(IssueId('plan23-1'))?.state).toBe('In Progress');

    await orchestrator.stop();
  });

  it('uses the project-configured inProgressState (operator override)', async () => {
    const tracker = new FakeTracker([makeIssue({ state: 'Todo' })]);
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      // Operator's team uses "Doing" instead of "In Progress".
      projects: defaultProjects(tracker, {
        activeStates: ['Todo', 'Doing'],
        inProgressState: 'Doing',
      }),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    expect(tracker.transitionCalls).toHaveLength(1);
    expect(tracker.transitionCalls[0]?.targetStateName).toBe('Doing');
    expect(tracker.getIssue(IssueId('plan23-1'))?.state).toBe('Doing');

    await orchestrator.stop();
  });

  it('short-circuits the API call when the issue is already in the target state (idempotent)', async () => {
    // Issue arrives already in "In Progress" — re-dispatches of an
    // in-flight issue would otherwise generate redundant API calls.
    const tracker = new FakeTracker([makeIssue({ state: 'In Progress' })]);
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker, { inProgressState: 'In Progress' }),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    // No API call issued; the orchestrator short-circuited.
    expect(tracker.transitionCalls).toHaveLength(0);

    await orchestrator.stop();
  });

  it('case-insensitive idempotency check (issue state casing differs from configured)', async () => {
    // Issue is in "IN PROGRESS" (Linear shouty-caps); configured
    // target is "In Progress". Still a noop — no API round-trip.
    const tracker = new FakeTracker([makeIssue({ state: 'IN PROGRESS' })]);
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker, {
        activeStates: ['Todo', 'IN PROGRESS'],
        inProgressState: 'In Progress',
      }),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    expect(tracker.transitionCalls).toHaveLength(0);

    await orchestrator.stop();
  });

  it('proceeds with dispatch even when the transition returns a typed error (non-blocking)', async () => {
    const tracker = new FakeTracker([makeIssue({ state: 'Todo' })]);
    // Queue a simulated transport failure for the next call.
    tracker.queueTransitionResult({
      ok: false,
      error: {
        code: 'linear_api_request',
        message: 'simulated network failure',
        cause: new Error('boom'),
      },
    });
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    // The transition was attempted (the error result was consumed).
    expect(tracker.transitionCalls).toHaveLength(1);
    // But the worker still ran — `completed` carries the issue id.
    const snap = orchestrator.snapshot();
    expect(snap.completed.has(IssueId('plan23-1'))).toBe(true);

    await orchestrator.stop();
  });

  it('proceeds with dispatch when the transition is skipped (target state not on team)', async () => {
    const tracker = new FakeTracker(
      [makeIssue({ state: 'Todo' })],
      // Available states deliberately exclude "In Progress" to
      // simulate operator misconfiguration.
      { availableStates: ['Todo', 'Doing', 'Done'] },
    );
    const config = buildConfig({ workspace: { root: workspaceRoot } });
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects: defaultProjects(tracker, { inProgressState: 'In Progress' }),
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    expect(tracker.transitionCalls).toHaveLength(1);
    // Worker still ran despite skipped transition.
    const snap = orchestrator.snapshot();
    expect(snap.completed.has(IssueId('plan23-1'))).toBe(true);
    // And the issue state was NOT mutated (skipped = no write).
    expect(tracker.getIssue(IssueId('plan23-1'))?.state).toBe('Todo');

    await orchestrator.stop();
  });
});
