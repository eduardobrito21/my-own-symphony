import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/runner.js';
import { IssueId, IssueIdentifier, composeSessionId } from '../types/index.js';

import {
  podNameFor,
  type DispatchEnvelope,
  type ImageSpec,
  type PodStartInput,
} from './backend.js';
import { FakeBackend } from './fake.js';

function makeImageSpec(overrides: Partial<ImageSpec> = {}): ImageSpec {
  return {
    projectKey: 'edu',
    preferred: 'base',
    workspacePath: '/tmp/ws/edu/issue-1',
    baseImage: 'symphony/agent-base:1',
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    issueId: IssueId('issue-1'),
    issueIdentifier: IssueIdentifier('EDU-1'),
    projectKey: 'edu',
    tracker: { kind: 'linear', projectSlug: 'c58e6fc4ca75' },
    repo: {
      url: 'https://github.com/eduardobrito/my-own-symphony.git',
      defaultBranch: 'main',
      workflowPath: '.symphony/workflow.md',
      branchPrefix: 'symphony/',
    },
    operatorCaps: { model: 'claude-haiku-4-5', maxTurns: 1, maxBudgetUsd: 1 },
    attempt: null,
    ...overrides,
  };
}

function makeStartInput(overrides: Partial<PodStartInput> = {}): PodStartInput {
  const envelope = makeEnvelope(overrides.envelope);
  return {
    projectKey: envelope.projectKey,
    issueId: envelope.issueId,
    issueIdentifier: envelope.issueIdentifier,
    workspacePath: '/tmp/ws/edu/issue-1',
    image: { tag: 'edu:fake', source: 'base' },
    envelope,
    env: {},
    ...overrides,
  };
}

const startedEvent: AgentEvent = {
  kind: 'session_started',
  sessionId: composeSessionId('thread-1', 'turn-1'),
  threadId: 'thread-1',
  turnId: 'turn-1',
  at: new Date('2026-04-30T00:00:00Z'),
};

const completedEvent: AgentEvent = {
  kind: 'turn_completed',
  turnNumber: 1,
  at: new Date('2026-04-30T00:00:01Z'),
};

describe('FakeBackend', () => {
  describe('ensureImage', () => {
    it('returns a synthesized base-source image when no override is set', async () => {
      const backend = new FakeBackend();
      const result = await backend.ensureImage(makeImageSpec());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ tag: 'edu:fake', source: 'base' });
      }
    });

    it('returns the configured override when one is set', async () => {
      const backend = new FakeBackend();
      backend.setImageResult('edu', {
        ok: true,
        value: { tag: 'symphony/agent:edu', source: 'repo-dockerfile' },
      });
      const result = await backend.ensureImage(makeImageSpec());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('repo-dockerfile');
        expect(result.value.tag).toBe('symphony/agent:edu');
      }
    });

    it('returns the configured error override', async () => {
      const backend = new FakeBackend();
      backend.setImageResult('edu', {
        ok: false,
        error: {
          code: 'image_not_found',
          message: 'tag not present locally',
          tag: 'symphony/agent:edu',
        },
      });
      const result = await backend.ensureImage(makeImageSpec());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('image_not_found');
      }
    });

    it('logs every call', async () => {
      const backend = new FakeBackend();
      const spec = makeImageSpec();
      await backend.ensureImage(spec);
      await backend.ensureImage(spec);
      const ensureCalls = backend.calls.filter((c) => c.method === 'ensureImage');
      expect(ensureCalls).toHaveLength(2);
    });
  });

  describe('start', () => {
    it('returns a handle with the scripted event stream', async () => {
      const backend = new FakeBackend();
      const podName = podNameFor('edu', IssueId('issue-1'));
      backend.setScenario(podName, { events: [startedEvent, completedEvent] });

      const result = await backend.start(makeStartInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const collected: AgentEvent[] = [];
      for await (const event of result.value.events) collected.push(event);
      expect(collected).toEqual([startedEvent, completedEvent]);
    });

    it('returns the configured start error when scripted', async () => {
      const backend = new FakeBackend();
      const podName = podNameFor('edu', IssueId('issue-1'));
      backend.setScenario(podName, {
        startError: {
          code: 'pod_start_failed',
          message: 'docker daemon offline',
          podName,
          cause: new Error('connect ECONNREFUSED'),
        },
      });

      const result = await backend.start(makeStartInput());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('pod_start_failed');
      }
    });

    it('is idempotent on (projectKey, issueId)', async () => {
      const backend = new FakeBackend();
      const first = await backend.start(makeStartInput());
      const second = await backend.start(makeStartInput());
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        // Same handle (same podId, same logical identity)
        expect(first.value.podId).toBe(second.value.podId);
        expect(first.value).toBe(second.value);
      }
    });

    it('terminates the event stream cleanly when the abort signal fires mid-iteration', async () => {
      const backend = new FakeBackend();
      const podName = podNameFor('edu', IssueId('issue-1'));
      backend.setScenario(podName, { events: [startedEvent, completedEvent] });

      const controller = new AbortController();
      const result = await backend.start(makeStartInput({ signal: controller.signal }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      controller.abort();
      const collected: AgentEvent[] = [];
      for await (const event of result.value.events) collected.push(event);
      expect(collected).toEqual([]);
    });

    it('uses the standard pod name format for the handle id', async () => {
      const backend = new FakeBackend();
      const result = await backend.start(makeStartInput());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.podId).toBe('symphony-edu-issue-1');
      }
    });
  });

  describe('stop', () => {
    it('records the stop and reports success', async () => {
      const backend = new FakeBackend();
      const start = await backend.start(makeStartInput());
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const stop = await backend.stop(start.value);
      expect(stop.ok).toBe(true);
      expect(backend.wasStopped(start.value.podId)).toBe(true);
    });

    it('is safe to call on an already-stopped pod', async () => {
      const backend = new FakeBackend();
      const start = await backend.start(makeStartInput());
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      await backend.stop(start.value);
      const second = await backend.stop(start.value);
      expect(second.ok).toBe(true);
    });

    it('allows re-starting after stop (next dispatch creates a fresh handle)', async () => {
      const backend = new FakeBackend();
      const first = await backend.start(makeStartInput());
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await backend.stop(first.value);

      const second = await backend.start(makeStartInput());
      expect(second.ok).toBe(true);
      if (second.ok) {
        // Same podId (deterministic from the inputs) but a fresh
        // handle — the prior one was torn down.
        expect(second.value.podId).toBe(first.value.podId);
        expect(second.value).not.toBe(first.value);
      }
    });
  });

  describe('logsTail', () => {
    it('returns the configured logs', async () => {
      const backend = new FakeBackend();
      const podName = podNameFor('edu', IssueId('issue-1'));
      backend.setScenario(podName, { logsTail: 'last line of stderr\n' });
      const start = await backend.start(makeStartInput());
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const logs = await start.value.logsTail();
      expect(logs).toBe('last line of stderr\n');
    });

    it('returns an empty string when no logs are scripted', async () => {
      const backend = new FakeBackend();
      const start = await backend.start(makeStartInput());
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const logs = await start.value.logsTail();
      expect(logs).toBe('');
    });
  });
});
