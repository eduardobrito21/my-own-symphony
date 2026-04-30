// LocalDockerBackend unit tests with a mocked `docker` runner +
// real TCP loopback for the event-stream round trip.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NULL_LOGGER } from '../../observability/index.js';
import { IssueId, IssueIdentifier } from '../../types/index.js';
import type { DispatchEnvelope, ImageRef, PodStartInput } from '../backend.js';

import { LocalDockerBackend, buildDispatchEnvelope } from './backend.js';
import type { DockerResult, DockerRunner } from './docker-runner.js';

/** Mirrors `LocalDockerBackend.start`'s short-id derivation so tests
 *  can compute the host-side envelope path without poking at internals. */
function shortPodId(podName: string): string {
  return createHash('sha256').update(podName).digest('hex').slice(0, 12);
}

const ok: DockerResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };
const noSuchContainer: DockerResult = {
  ok: false,
  exitCode: 1,
  stdout: '',
  stderr: 'No such container: foo',
  signal: null,
};

const RESOLVED_IMAGE: ImageRef = { tag: 'symphony/agent-base:1', source: 'base' };

const DEFAULT_ENVELOPE: DispatchEnvelope = buildDispatchEnvelope({
  issueId: 'issue-id',
  issueIdentifier: 'EDU-1',
  projectKey: 'edu',
  trackerProjectSlug: 'edu-slug',
  repoUrl: 'https://example.com/repo.git',
  defaultBranch: 'main',
  workflowPath: '.symphony/workflow.md',
  branchPrefix: 'symphony/',
  operatorCaps: {},
  attempt: null,
});

interface RecordedCall {
  readonly args: readonly string[];
}

function emptyEvents(): AsyncIterable<never> {
  // Sentinel for the stop-only paths that need a PodHandle but
  // never iterate it. The iterable produces no events.
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        next: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

function makeRecorder(handler: (args: readonly string[]) => DockerResult): {
  runner: DockerRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: DockerRunner = (args) => {
    calls.push({ args: [...args] });
    return Promise.resolve(handler(args));
  };
  return { runner, calls };
}

/** Pull `127.0.0.1:<port>` out of the SYMPHONY_EVENT_HOST docker arg
 *  the backend constructs. The docker invocation maps it to
 *  `host.docker.internal:<port>`; we substitute back to loopback for
 *  the in-test client to actually reach the listener. */
function eventPortFromArgs(args: readonly string[]): number {
  const envArg = args.find((a) => a.startsWith('SYMPHONY_EVENT_HOST='));
  if (envArg === undefined) throw new Error('SYMPHONY_EVENT_HOST not set on docker run');
  const value = envArg.slice('SYMPHONY_EVENT_HOST='.length);
  const idx = value.lastIndexOf(':');
  return Number.parseInt(value.slice(idx + 1), 10);
}

describe('LocalDockerBackend.start', () => {
  let transientRoot: string;
  let workspacePath: string;

  beforeEach(async () => {
    transientRoot = await mkdtemp(join(tmpdir(), 'symphony-backend-'));
    workspacePath = await mkdtemp(join(tmpdir(), 'symphony-ws-'));
  });

  afterEach(async () => {
    await rm(transientRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  function startInput(overrides: Partial<PodStartInput> = {}): PodStartInput {
    return {
      projectKey: 'edu',
      issueId: IssueId('issue-id'),
      issueIdentifier: IssueIdentifier('EDU-1'),
      workspacePath,
      image: RESOLVED_IMAGE,
      envelope: DEFAULT_ENVELOPE,
      env: { LINEAR_API_KEY: 'sk-test' },
      ...overrides,
    };
  }

  it('runs `docker run` with the right mounts and env', async () => {
    const { runner, calls } = makeRecorder(() => ok);
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: runner,
    });

    const result = await backend.start(startInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.podId).toBe('symphony-edu-issue-id');

    const runCall = calls.find((c) => c.args[0] === 'run');
    expect(runCall).toBeDefined();
    const args = runCall?.args ?? [];
    // `--rm` is intentionally NOT used — exited pods stick around so
    // operators can `docker logs <pod-name>` post-mortem.
    expect(args).not.toContain('--rm');
    expect(args).toContain('-d');
    expect(args).toContain('symphony-edu-issue-id');
    // host.docker.internal mapping for Linux compatibility.
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    // Workspace mount.
    expect(args.some((a) => a === `${workspacePath}:/workspace`)).toBe(true);
    // Envelope mount (read-only).
    expect(args.some((a) => a.endsWith(':/etc/symphony/dispatch.json:ro'))).toBe(true);
    // Event host env var (host.docker.internal:<port>).
    expect(args.some((a) => a.startsWith('SYMPHONY_EVENT_HOST=host.docker.internal:'))).toBe(true);
    // Caller env var.
    expect(args.some((a) => a === 'LINEAR_API_KEY=sk-test')).toBe(true);
    // Image last.
    expect(args[args.length - 1]).toBe(RESOLVED_IMAGE.tag);

    // Cleanup
    await backend.stop(result.value);
  });

  it('writes the dispatch envelope to the host', async () => {
    const { runner } = makeRecorder(() => ok);
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: runner,
    });

    const result = await backend.start(startInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const envelopePath = join(transientRoot, `${shortPodId('symphony-edu-issue-id')}.json`);
    const written = JSON.parse(await readFile(envelopePath, 'utf8')) as {
      issueId: string;
      repo: { url: string };
    };
    expect(written.issueId).toBe('issue-id');
    expect(written.repo.url).toBe('https://example.com/repo.git');

    await backend.stop(result.value);
  });

  it('returns pod_start_failed when docker run errors', async () => {
    const { runner } = makeRecorder((args) =>
      args[0] === 'run'
        ? { ok: false, exitCode: 125, stdout: '', stderr: 'docker daemon offline', signal: null }
        : ok,
    );
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: runner,
    });

    const result = await backend.start(startInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pod_start_failed');
    expect(result.error.message).toContain('docker daemon offline');
  });

  it('reattaches to an existing handle when start is called twice for the same pod', async () => {
    const { runner, calls } = makeRecorder(() => ok);
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: runner,
    });

    const first = await backend.start(startInput());
    const second = await backend.start(startInput());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.podId).toBe(second.value.podId);
    // `docker run` should have been invoked exactly once across the
    // two start calls — the second resolved against the in-memory
    // handle map without spawning a duplicate.
    const runCalls = calls.filter((c) => c.args[0] === 'run');
    expect(runCalls).toHaveLength(1);

    await backend.stop(first.value);
  });
});

describe('LocalDockerBackend.stop', () => {
  let transientRoot: string;
  let workspacePath: string;

  beforeEach(async () => {
    transientRoot = await mkdtemp(join(tmpdir(), 'symphony-backend-stop-'));
    workspacePath = await mkdtemp(join(tmpdir(), 'symphony-ws-stop-'));
  });

  afterEach(async () => {
    await rm(transientRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('returns ok when the pod is already gone (idempotent)', async () => {
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: () => Promise.resolve(noSuchContainer),
    });
    const result = await backend.stop({
      podId: 'symphony-edu-issue-id',
      events: emptyEvents(),
      logsTail: () => Promise.resolve(''),
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok on a clean stop + rm', async () => {
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: () => Promise.resolve(ok),
    });
    const result = await backend.stop({
      podId: 'symphony-edu-issue-id',
      events: emptyEvents(),
      logsTail: () => Promise.resolve(''),
    });
    expect(result.ok).toBe(true);
  });
});

describe('LocalDockerBackend event-protocol round trip', () => {
  let transientRoot: string;
  let workspacePath: string;

  beforeEach(async () => {
    transientRoot = await mkdtemp(join(tmpdir(), 'symphony-backend-events-'));
    workspacePath = await mkdtemp(join(tmpdir(), 'symphony-ws-events-'));
  });

  afterEach(async () => {
    await rm(transientRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('a JSON-line writer connecting to the bound TCP listener yields parsed events on the daemon side', async () => {
    const { runner, calls } = makeRecorder(() => ok);
    const backend = new LocalDockerBackend({
      baseImage: 'symphony/agent-base:1',
      transientRoot,
      logger: NULL_LOGGER,
      runDocker: runner,
    });

    const startResult = await backend.start({
      projectKey: 'edu',
      issueId: IssueId('round-trip'),
      issueIdentifier: IssueIdentifier('EDU-2'),
      workspacePath,
      image: RESOLVED_IMAGE,
      envelope: { ...DEFAULT_ENVELOPE, issueId: 'round-trip', issueIdentifier: 'EDU-2' },
      env: {},
    });
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // The backend told docker to set SYMPHONY_EVENT_HOST=host.docker.internal:<port>.
    // We're not in a docker container — connect directly to 127.0.0.1:<port>.
    const runCall = calls.find((c) => c.args[0] === 'run');
    if (runCall === undefined) throw new Error('docker run not called');
    const port = eventPortFromArgs(runCall.args);

    // Simulate the in-pod agent: connect to the TCP listener and
    // write JSON-line events. Run this concurrently with the
    // daemon-side iteration.
    const writer = new Promise<void>((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port });
      sock.on('connect', () => {
        const at = new Date('2026-04-30T12:00:00Z').toISOString();
        sock.write(`${JSON.stringify({ kind: 'notification', message: 'hi', at })}\n`);
        sock.write(`${JSON.stringify({ kind: 'turn_completed', turnNumber: 1, at })}\n`);
        sock.end(() => {
          resolve();
        });
      });
      sock.on('error', reject);
    });

    const collected: { kind: string }[] = [];
    for await (const event of startResult.value.events) {
      collected.push({ kind: event.kind });
      if (event.kind === 'turn_completed') break;
    }
    await writer;

    expect(collected.map((e) => e.kind)).toEqual(['notification', 'turn_completed']);

    await backend.stop(startResult.value);
  });
});
