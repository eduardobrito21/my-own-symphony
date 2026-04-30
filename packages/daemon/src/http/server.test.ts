// HTTP server smoke tests.
//
// We boot the real server on a random free port (port: 0), hit it
// with `fetch`, and assert response shapes. No mocking — these are
// integration tests of the route surface.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NULL_LOGGER } from '../observability/index.js';
import type { OrchestratorState } from '../types/index.js';

import { startHttpServer, type RunningHttpServer } from './server.js';

function emptyState(): OrchestratorState {
  return {
    pollIntervalMs: 30_000,
    maxConcurrentAgents: 5,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    agentTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    projects: [],
    agentRateLimits: null,
  };
}

describe('startHttpServer', () => {
  let server: RunningHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = await startHttpServer({
      port: 0, // OS-assigned
      getSnapshot: emptyState,
      daemonStartedAt: new Date('2026-04-29T10:00:00Z'),
      now: () => new Date('2026-04-29T10:30:00Z'),
      monotonicNow: () => 0,
      logger: NULL_LOGGER,
    });
    baseUrl = `http://127.0.0.1:${String(server.port)}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('binds loopback by default (cannot be reached on a non-loopback address)', () => {
    // We assert the address by construction — startHttpServer defaults
    // host to 127.0.0.1. A negative test would be too flaky in CI.
    const addr = server.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
  });

  describe('GET /api/v1/health', () => {
    it('returns { status: "ok" } on 200', async () => {
      const r = await fetch(`${baseUrl}/api/v1/health`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      const body = (await r.json()) as { status: string };
      expect(body).toEqual({ status: 'ok' });
    });

    it('sets CORS headers so the dashboard (different port) can read', async () => {
      const r = await fetch(`${baseUrl}/api/v1/health`);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('GET /api/v1/state', () => {
    it('returns the empty snapshot in wire shape', async () => {
      const r = await fetch(`${baseUrl}/api/v1/state`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        pollIntervalMs: 30_000,
        maxConcurrentAgents: 5,
        running: [],
        claimed: [],
        retryAttempts: [],
        completed: [],
        agentTotals: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          secondsRunning: 0,
        },
        agentRateLimits: null,
        now: '2026-04-29T10:30:00.000Z',
        daemonStartedAt: '2026-04-29T10:00:00.000Z',
      });
    });

    it('returns 500 when snapshot accessor throws', async () => {
      // Spin up a separate server with a throwing snapshot to keep
      // the per-test happy path isolated.
      const failing = await startHttpServer({
        port: 0,
        getSnapshot: () => {
          throw new Error('intentional snapshot failure');
        },
        daemonStartedAt: new Date(),
        logger: NULL_LOGGER,
      });
      try {
        const r = await fetch(`http://127.0.0.1:${String(failing.port)}/api/v1/state`);
        expect(r.status).toBe(500);
        const body = (await r.json()) as { error: { code: string } };
        expect(body.error.code).toBe('snapshot_failed');
      } finally {
        await failing.close();
      }
    });
  });

  describe('OPTIONS preflight', () => {
    it('returns 204 with CORS headers (no body)', async () => {
      const r = await fetch(`${baseUrl}/api/v1/state`, { method: 'OPTIONS' });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-methods')).toMatch(/GET/);
    });
  });

  describe('unknown routes / wrong methods', () => {
    it('returns 404 for an unmapped path', async () => {
      const r = await fetch(`${baseUrl}/api/v1/whatever`);
      expect(r.status).toBe(404);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });

    it('returns 405 for a non-GET method on a known endpoint', async () => {
      const r = await fetch(`${baseUrl}/api/v1/state`, {
        method: 'POST',
        body: '',
      });
      expect(r.status).toBe(405);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe('method_not_allowed');
    });
  });
});

describe('serializeState — through the live endpoint', () => {
  it('round-trips a non-trivial running entry as a JSON-safe object', async () => {
    // Build a state with one running issue + one retrying issue and
    // confirm the wire shape is what the dashboard would expect.
    const issueId = 'iss-1';
    const state: OrchestratorState = {
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 5,
      running: new Map([
        [
          issueId as unknown as never,
          {
            issue: {
              id: issueId as unknown as never,
              identifier: 'EDU-1' as unknown as never,
              projectKey: 'default' as unknown as never,
              title: 'Bump eslint',
              description: 'desc',
              priority: 1,
              state: 'In Progress',
              branchName: null,
              url: 'https://linear.app/example/issue/EDU-1',
              labels: ['chore'],
              blockedBy: [],
              createdAt: new Date('2026-04-29T09:00:00Z'),
              updatedAt: null,
            },
            session: {
              sessionId: 'sess-1' as unknown as never,
              threadId: 'thread-1',
              turnId: 'turn-1',
              agentRuntimePid: null,
              lastAgentEvent: 'tool_call',
              lastAgentTimestamp: new Date('2026-04-29T10:25:00Z'),
              lastAgentMessage: 'calling mcp__linear__linear_graphql',
              tokens: {
                inputTokens: 1500,
                outputTokens: 200,
                totalTokens: 1700,
                lastReportedInputTokens: 0,
                lastReportedOutputTokens: 0,
                lastReportedTotalTokens: 0,
              },
              turnCount: 1,
            },
            startedAt: new Date('2026-04-29T10:00:00Z'),
            retryAttempt: null,
          },
        ],
      ]),
      claimed: new Set([issueId as unknown as never]),
      retryAttempts: new Map([
        [
          'iss-2' as unknown as never,
          {
            issueId: 'iss-2' as unknown as never,
            identifier: 'EDU-2' as unknown as never,
            projectKey: 'default' as unknown as never,
            attempt: 2,
            // monotonicNow is 0 in the test → dueAtMs of 5000 → due in 5s.
            dueAtMs: 5_000,
            timerHandle: null,
            error: 'tool_call_failed',
          },
        ],
      ]),
      completed: new Set(['iss-3' as unknown as never]),
      agentTotals: {
        inputTokens: 5_000,
        outputTokens: 700,
        totalTokens: 5_700,
        secondsRunning: 42.5,
      },
      projects: [],
      agentRateLimits: { remaining: 100 },
    };

    const server = await startHttpServer({
      port: 0,
      getSnapshot: () => state,
      daemonStartedAt: new Date('2026-04-29T10:00:00Z'),
      now: () => new Date('2026-04-29T10:30:00Z'),
      monotonicNow: () => 0,
      logger: NULL_LOGGER,
    });
    try {
      const r = await fetch(`http://127.0.0.1:${String(server.port)}/api/v1/state`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        running: { id: string; issue: { identifier: string }; session: { tokens: unknown } }[];
        claimed: string[];
        retryAttempts: { id: string; identifier: string; dueInMs: number }[];
        completed: string[];
        agentTotals: { totalTokens: number };
      };

      expect(body.running).toHaveLength(1);
      expect(body.running[0]?.id).toBe(issueId);
      expect(body.running[0]?.issue.identifier).toBe('EDU-1');

      expect(body.claimed).toEqual([issueId]);

      expect(body.retryAttempts).toHaveLength(1);
      expect(body.retryAttempts[0]?.identifier).toBe('EDU-2');
      expect(body.retryAttempts[0]?.dueInMs).toBe(5_000);

      expect(body.completed).toEqual(['iss-3']);
      expect(body.agentTotals.totalTokens).toBe(5_700);
    } finally {
      await server.close();
    }
  });
});
