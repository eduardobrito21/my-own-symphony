// Plan 09c — multi-project orchestrator integration tests.
//
// These exercise the orchestrator with N projects, each backed by its
// own FakeTracker. The whole point is to verify that:
//
//   1. The tick loop polls every project's tracker (not just one).
//   2. Issues are stamped with the right `projectKey` after fetch.
//   3. Workspaces land under `<root>/<projectKey>/<id>/`.
//   4. The snapshot's `projects[]` breakdown counts per project,
//      in deployment YAML order.
//   5. A failure on one project's tracker fetch does not stall the
//      others — that project is skipped this tick, the rest proceed.
//   6. Reconcile fans out per-project (terminal state in project A
//      terminates project A's worker without touching project B).
//
// We use FakeBackend isn't relevant here — Plan 09c keeps the
// orchestrator on AgentRunner (Plan 10 swaps to ExecutionBackend).
// Tests inject MockAgent for fast turns.

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockAgent } from '../agent/mock/mock-agent.js';
import type { ServiceConfig } from '../config/schema.js';
import { NULL_LOGGER } from '../observability/index.js';
import { FakeTracker } from '../tracker/fake/fake-tracker.js';
import type { Tracker, TrackerResult } from '../tracker/tracker.js';
import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../types/index.js';
import { WorkspaceManager } from '../workspace/index.js';

import { Orchestrator, type TimerSchedule } from './orchestrator.js';
import { singleProjectContext } from './project.js';
import type { ProjectContext, ProjectContextMap } from './project.js';

const NEVER_FIRING_SCHEDULE: TimerSchedule = {
  setTimeout: () => null,
  clearTimeout: () => undefined,
};

function makeIssue(id: string, identifier: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId(id),
    identifier: IssueIdentifier(identifier),
    projectKey: ProjectKey('default'), // overwritten by orchestrator stamping
    title: 't',
    description: null,
    priority: null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date('2026-04-30T10:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

function buildConfig(workspaceRoot: string): ServiceConfig {
  return {
    tracker: {
      endpoint: 'https://api.linear.app/graphql',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Cancelled'],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: workspaceRoot },
    hooks: { timeout_ms: 5_000 },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      turn_timeout_ms: 60_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 0, // disable for tests; we don't drive elapsed time
    },
  };
}

function ctx(
  key: string,
  tracker: Tracker,
  opts: { activeStates?: readonly string[]; terminalStates?: readonly string[] } = {},
): ProjectContext {
  return {
    key: ProjectKey(key),
    tracker,
    activeStates: opts.activeStates ?? ['Todo', 'In Progress'],
    terminalStates: opts.terminalStates ?? ['Done', 'Cancelled'],
  };
}

function multiProjectMap(...contexts: ProjectContext[]): ProjectContextMap {
  return new Map(contexts.map((c) => [c.key, c]));
}

describe('Orchestrator — Plan 09c multi-project', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-orch-mp-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('dispatches across two projects in one tick', async () => {
    const trackerA = new FakeTracker([makeIssue('a-1', 'EDU-A1')]);
    const trackerB = new FakeTracker([makeIssue('b-1', 'MKT-B1')]);
    const projects = multiProjectMap(ctx('edu', trackerA), ctx('mkt', trackerB));

    const config = buildConfig(workspaceRoot);
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects,
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    const snapshot = orchestrator.snapshot();
    expect(snapshot.completed.has(IssueId('a-1'))).toBe(true);
    expect(snapshot.completed.has(IssueId('b-1'))).toBe(true);

    await orchestrator.stop();
  });

  it('stamps the right projectKey on issues from each tracker', async () => {
    const trackerA = new FakeTracker([makeIssue('a-1', 'EDU-A1')]);
    const trackerB = new FakeTracker([makeIssue('b-1', 'MKT-B1')]);
    const projects = multiProjectMap(ctx('edu', trackerA), ctx('mkt', trackerB));

    const config = buildConfig(workspaceRoot);
    // Slow agent so issues stay in `running` while we observe.
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects,
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5_000 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    const snapshot = orchestrator.snapshot();
    const a = snapshot.running.get(IssueId('a-1'));
    const b = snapshot.running.get(IssueId('b-1'));
    expect(a?.issue.projectKey).toBe('edu');
    expect(b?.issue.projectKey).toBe('mkt');

    await orchestrator.stop();
  });

  it('namespaces workspaces by projectKey on disk', async () => {
    const trackerA = new FakeTracker([makeIssue('a-1', 'EDU-A1')]);
    const trackerB = new FakeTracker([makeIssue('b-1', 'MKT-B1')]);
    const projects = multiProjectMap(ctx('edu', trackerA), ctx('mkt', trackerB));

    const config = buildConfig(workspaceRoot);
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects,
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();

    // Workspaces should land under <root>/<projectKey>/<id>/.
    const eduDir = await stat(join(workspaceRoot, 'edu', 'EDU-A1'));
    const mktDir = await stat(join(workspaceRoot, 'mkt', 'MKT-B1'));
    expect(eduDir.isDirectory()).toBe(true);
    expect(mktDir.isDirectory()).toBe(true);

    await orchestrator.stop();
  });

  it('snapshot.projects has one entry per project, in deployment order', async () => {
    const trackerA = new FakeTracker([makeIssue('a-1', 'EDU-A1')]);
    const trackerB = new FakeTracker([makeIssue('b-1', 'MKT-B1')]);
    const projects = multiProjectMap(ctx('edu', trackerA), ctx('mkt', trackerB));

    const config = buildConfig(workspaceRoot);
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects,
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5_000 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    const snap = orchestrator.snapshot();
    expect(snap.projects).toHaveLength(2);
    expect(snap.projects.map((p) => p.projectKey)).toEqual(['edu', 'mkt']);
    expect(snap.projects[0]?.running).toBe(1);
    expect(snap.projects[1]?.running).toBe(1);

    await orchestrator.stop();
  });

  it('continues other projects when one tracker fetch fails', async () => {
    // failingTracker yields a typed error from fetchCandidateIssues.
    const failingTracker: Tracker = {
      fetchCandidateIssues: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'linear_api_request', message: 'boom', cause: new Error('boom') },
        } satisfies TrackerResult<readonly Issue[]>),
      fetchIssuesByStates: () => Promise.resolve({ ok: true, value: [] }),
      fetchIssueStatesByIds: () => Promise.resolve({ ok: true, value: [] }),
    };
    const trackerB = new FakeTracker([makeIssue('b-1', 'MKT-B1')]);
    const projects = multiProjectMap(ctx('edu', failingTracker), ctx('mkt', trackerB));

    const config = buildConfig(workspaceRoot);
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects,
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    await orchestrator.drain();
    const snap = orchestrator.snapshot();
    // Project B's issue should still complete despite project A's
    // tracker error.
    expect(snap.completed.has(IssueId('b-1'))).toBe(true);

    await orchestrator.stop();
  });

  it('reconcile terminates issues whose tracker reports terminal state', async () => {
    const issueA = makeIssue('a-1', 'EDU-A1', { state: 'Todo' });
    const trackerA = new FakeTracker([issueA]);
    const projects = singleProjectContext({
      key: ProjectKey('edu'),
      tracker: trackerA,
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
    });

    const config = buildConfig(workspaceRoot);
    const orchestrator = new Orchestrator({
      config,
      promptTemplateSource: 'work on {{ issue.identifier }}',
      projects,
      workspaceManager: new WorkspaceManager({ root: workspaceRoot, hooks: config.hooks }),
      agent: new MockAgent({ turnDurationMs: 5_000 }),
      logger: NULL_LOGGER,
      schedule: NEVER_FIRING_SCHEDULE,
    });

    await orchestrator.tick();
    expect(orchestrator.snapshot().running.size).toBe(1);

    // Move the issue to terminal state and run another tick — reconcile
    // fires before dispatch and terminates the worker.
    trackerA.setIssueState(IssueId('a-1'), 'Done');
    await orchestrator.tick();
    await orchestrator.drain();

    expect(orchestrator.snapshot().running.size).toBe(0);

    await orchestrator.stop();
  });
});
