import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServiceConfig } from '../config/schema.js';
import { NULL_LOGGER } from '../observability/index.js';
import { FakeTracker } from '../tracker/fake/fake-tracker.js';
import { IssueId, IssueIdentifier, type Issue } from '../types/index.js';
import { WorkspaceManager } from '../workspace/index.js';

import { startupTerminalCleanup } from './startup.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    title: 't',
    description: null,
    priority: null,
    state: 'Done',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const CONFIG: ServiceConfig = {
  tracker: {
    endpoint: 'https://api.linear.app/graphql',
    active_states: ['Todo'],
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
    stall_timeout_ms: 0,
  },
};

describe('startupTerminalCleanup', () => {
  let root: string;
  let workspaceManager: WorkspaceManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'symphony-startup-test-'));
    workspaceManager = new WorkspaceManager({ root, hooks: CONFIG.hooks });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes workspaces for issues in terminal states', async () => {
    // Pre-create a workspace dir for SYMP-1 to simulate leftover.
    await mkdir(join(root, 'SYMP-1'));
    expect((await stat(join(root, 'SYMP-1'))).isDirectory()).toBe(true);

    const tracker = new FakeTracker([makeIssue({ state: 'Done' })]);
    await startupTerminalCleanup({
      tracker,
      workspaceManager,
      config: { ...CONFIG, workspace: { root } },
      logger: NULL_LOGGER,
    });

    let stillExists = false;
    try {
      await stat(join(root, 'SYMP-1'));
      stillExists = true;
    } catch {
      stillExists = false;
    }
    expect(stillExists).toBe(false);
  });

  it('is a no-op when there are no terminal issues', async () => {
    const tracker = new FakeTracker([]);
    await expect(
      startupTerminalCleanup({
        tracker,
        workspaceManager,
        config: { ...CONFIG, workspace: { root } },
        logger: NULL_LOGGER,
      }),
    ).resolves.toBeUndefined();
  });

  it('skips workspaces that do not exist on disk', async () => {
    // Tracker returns a Done issue, but no workspace exists.
    const tracker = new FakeTracker([
      makeIssue({ id: IssueId('ghost'), identifier: IssueIdentifier('SYMP-GHOST') }),
    ]);
    await expect(
      startupTerminalCleanup({
        tracker,
        workspaceManager,
        config: { ...CONFIG, workspace: { root } },
        logger: NULL_LOGGER,
      }),
    ).resolves.toBeUndefined();
  });
});
