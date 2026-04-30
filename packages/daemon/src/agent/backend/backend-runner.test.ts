// Unit tests for the `BackendAgentRunner` adapter — uses the
// existing `FakeBackend` (Plan 09) to drive the dispatch flow without
// docker.

import { describe, expect, it } from 'vitest';

import { FakeBackend, podNameFor } from '../../execution/index.js';
import { NULL_LOGGER } from '../../observability/index.js';
import { IssueId, IssueIdentifier, ProjectKey } from '../../types/index.js';
import type { AgentEvent } from '../runner.js';

import { BackendAgentRunner, type ProjectDispatchInfo } from './backend-runner.js';

const PROJECT = ProjectKey('edu');

const DISPATCH: ReadonlyMap<ProjectKey, ProjectDispatchInfo> = new Map([
  [
    PROJECT,
    {
      trackerProjectSlug: 'edu-slug',
      repo: {
        url: 'https://example.com/repo.git',
        defaultBranch: 'main',
        workflowPath: '.symphony/workflow.md',
        branchPrefix: 'symphony/',
      },
    },
  ],
]);

function makeRunner(backend: FakeBackend): BackendAgentRunner {
  return new BackendAgentRunner({
    backend,
    projectDispatch: DISPATCH,
    operatorCaps: { maxTurns: 20 },
    baseImage: 'symphony/agent-base:1',
    env: { LINEAR_API_KEY: 'sk-test' },
    logger: NULL_LOGGER,
  });
}

describe('BackendAgentRunner', () => {
  it('forwards events from the backend handle to the orchestrator', async () => {
    const backend = new FakeBackend();
    const issueId = IssueId('issue-1');
    const podName = podNameFor(PROJECT, issueId);
    const at = new Date('2026-04-30T12:00:00Z');
    backend.setScenario(podName, {
      events: [
        { kind: 'notification', message: 'hi', at },
        { kind: 'turn_completed', turnNumber: 1, at },
      ],
    });

    const runner = makeRunner(backend);
    const collected: AgentEvent[] = [];
    for await (const event of runner.run({
      issueId,
      issueIdentifier: IssueIdentifier('EDU-1'),
      workspacePath: '/tmp/ws',
      prompt: '<unused — pod re-renders>',
      attempt: null,
    })) {
      collected.push(event);
    }
    expect(collected.map((e) => e.kind)).toEqual(['notification', 'turn_completed']);
    expect(backend.wasStopped(podName)).toBe(true);
  });

  it('emits turn_failed when ensureImage fails', async () => {
    const backend = new FakeBackend();
    backend.setImageResult(PROJECT, {
      ok: false,
      error: { code: 'image_not_found', tag: 'symphony/agent-base:1', message: 'missing' },
    });

    const runner = makeRunner(backend);
    const collected: AgentEvent[] = [];
    for await (const event of runner.run({
      issueId: IssueId('issue-2'),
      issueIdentifier: IssueIdentifier('EDU-2'),
      workspacePath: '/tmp/ws',
      prompt: '',
      attempt: null,
    })) {
      collected.push(event);
    }
    expect(collected).toHaveLength(1);
    const first = collected[0];
    expect(first?.kind).toBe('turn_failed');
    if (first?.kind === 'turn_failed') {
      expect(first.reason).toContain('image_not_found');
    }
  });

  it('synthesizes turn_failed when stream ends without a terminal event', async () => {
    const backend = new FakeBackend();
    const issueId = IssueId('issue-3');
    const podName = podNameFor(PROJECT, issueId);
    backend.setScenario(podName, {
      events: [{ kind: 'notification', message: 'half-finished', at: new Date() }],
    });

    const runner = makeRunner(backend);
    const collected: AgentEvent[] = [];
    for await (const event of runner.run({
      issueId,
      issueIdentifier: IssueIdentifier('EDU-3'),
      workspacePath: '/tmp/ws',
      prompt: '',
      attempt: null,
    })) {
      collected.push(event);
    }
    expect(collected.map((e) => e.kind)).toEqual(['notification', 'turn_failed']);
  });

  it('emits turn_failed when start fails', async () => {
    const backend = new FakeBackend();
    const issueId = IssueId('issue-4');
    const podName = podNameFor(PROJECT, issueId);
    backend.setScenario(podName, {
      startError: {
        code: 'pod_start_failed',
        message: 'docker daemon offline',
        podName,
        cause: 'mock',
      },
    });

    const runner = makeRunner(backend);
    const collected: AgentEvent[] = [];
    for await (const event of runner.run({
      issueId,
      issueIdentifier: IssueIdentifier('EDU-4'),
      workspacePath: '/tmp/ws',
      prompt: '',
      attempt: null,
    })) {
      collected.push(event);
    }
    expect(collected).toHaveLength(1);
    const first = collected[0];
    expect(first?.kind).toBe('turn_failed');
    if (first?.kind === 'turn_failed') {
      expect(first.reason).toContain('pod_start_failed');
    }
  });
});
