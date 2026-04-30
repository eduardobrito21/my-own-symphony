// Unit tests for `NamespaceBackend` using an in-memory
// `RecordingInstanceRunner`. Mirrors the test pattern in
// `local-docker/backend.test.ts` (mocked-runner, real backend).

import { describe, expect, it } from 'vitest';

import { NULL_LOGGER } from '../../observability/index.js';
import { IssueId, IssueIdentifier } from '../../types/index.js';
import { buildDispatchEnvelope } from '../local-docker/backend.js';
import type { ImageRef, PodStartInput } from '../backend.js';

import { NamespaceBackend } from './backend.js';
import type {
  CreateInstanceArgs,
  InstanceRunner,
  RunCommandArgs,
  RunCommandChunk,
  RunCommandSyncResult,
} from './instance-runner.js';

const RESOLVED_IMAGE: ImageRef = { tag: 'symphony/agent-base:1', source: 'base' };

const DEFAULT_ENVELOPE = buildDispatchEnvelope({
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

interface CallRecord {
  readonly kind: string;
  readonly args: unknown;
}

class RecordingInstanceRunner implements InstanceRunner {
  readonly calls: CallRecord[] = [];
  private nextInstanceId = 'inst-001';
  private syncResults: RunCommandSyncResult[] = [];
  private streamChunks: RunCommandChunk[] = [];

  setNextInstanceId(id: string): void {
    this.nextInstanceId = id;
  }

  enqueueSyncResult(r: RunCommandSyncResult): void {
    this.syncResults.push(r);
  }

  setStreamChunks(chunks: RunCommandChunk[]): void {
    this.streamChunks = chunks;
  }

  createInstance(args: CreateInstanceArgs): Promise<{ instanceId: string }> {
    this.calls.push({ kind: 'createInstance', args });
    return Promise.resolve({ instanceId: this.nextInstanceId });
  }

  waitInstance(instanceId: string): Promise<void> {
    this.calls.push({ kind: 'waitInstance', args: { instanceId } });
    return Promise.resolve();
  }

  runCommandSync(args: RunCommandArgs): Promise<RunCommandSyncResult> {
    this.calls.push({ kind: 'runCommandSync', args });
    const next = this.syncResults.shift();
    return Promise.resolve(next ?? { exitCode: 0, stdout: '', stderr: '' });
  }

  runCommandStream(args: RunCommandArgs): AsyncIterable<RunCommandChunk> {
    this.calls.push({ kind: 'runCommandStream', args });
    const chunks = this.streamChunks;
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunCommandChunk> {
        let i = 0;
        return {
          next(): Promise<IteratorResult<RunCommandChunk>> {
            if (i >= chunks.length) {
              return Promise.resolve({ value: undefined, done: true });
            }
            const value = chunks[i++]!;
            return Promise.resolve({ value, done: false });
          },
        };
      },
    };
  }

  destroyInstance(instanceId: string, reason: string): Promise<void> {
    this.calls.push({ kind: 'destroyInstance', args: { instanceId, reason } });
    return Promise.resolve();
  }
}

function makeBackend(runner: InstanceRunner): NamespaceBackend {
  return new NamespaceBackend({
    baseImage: 'ghcr.io/namespacelabs/devbox/ubuntu-24.04:latest',
    shape: { vcpu: 2, memoryMb: 4096, arch: 'amd64' },
    maxLifetimeMs: 30 * 60 * 1000,
    symphonyRepoUrl: 'https://github.com/eduardobrito21/my-own-symphony.git',
    symphonyRef: 'main',
    logger: NULL_LOGGER,
    runner,
  });
}

function startInput(): PodStartInput {
  return {
    projectKey: 'edu',
    issueId: IssueId('issue-id'),
    issueIdentifier: IssueIdentifier('EDU-1'),
    workspacePath: '/unused', // NamespaceBackend doesn't bind-mount
    image: RESOLVED_IMAGE,
    envelope: DEFAULT_ENVELOPE,
    env: { LINEAR_API_KEY: 'sk-test' },
  };
}

describe('NamespaceBackend.start', () => {
  it('creates an instance with the configured shape and propagates env', async () => {
    const runner = new RecordingInstanceRunner();
    const backend = makeBackend(runner);

    const result = await backend.start(startInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.podId).toBe('symphony-edu-issue-id');

    const create = runner.calls.find((c) => c.kind === 'createInstance');
    expect(create).toBeDefined();
    const createArgs = create!.args as CreateInstanceArgs;
    expect(createArgs.shape).toEqual({ vcpu: 2, memoryMb: 4096, arch: 'amd64' });
    expect(createArgs.containerName).toBe('main');
    expect(createArgs.env['LINEAR_API_KEY']).toBe('sk-test');
    expect(createArgs.documentedPurpose).toContain('symphony-edu-issue-id');
  });

  it('runs the staging + clone + compose commands in order', async () => {
    const runner = new RecordingInstanceRunner();
    const backend = makeBackend(runner);

    await backend.start(startInput());

    const syncCalls = runner.calls
      .filter((c) => c.kind === 'runCommandSync')
      .map((c) => (c.args as RunCommandArgs).command.join(' '));
    expect(syncCalls.length).toBeGreaterThanOrEqual(3);
    // Stage step: clones the symphony repo into /opt/symphony
    expect(syncCalls[0]).toContain('/opt/symphony');
    expect(syncCalls[0]).toContain('git clone');
    // Clone step: clones the target repo into /workspace
    expect(syncCalls[1]).toContain('/workspace');
    expect(syncCalls[1]).toContain('symphony/EDU-1');
    // Compose step: probes for compose files
    expect(syncCalls[2]).toContain('docker compose');
  });

  it('returns pod_start_failed and destroys the instance when staging fails', async () => {
    const runner = new RecordingInstanceRunner();
    runner.enqueueSyncResult({ exitCode: 1, stdout: '', stderr: 'fatal: clone failed' });
    const backend = makeBackend(runner);

    const result = await backend.start(startInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pod_start_failed');
    expect(result.error.message).toContain('staging failed');
    // Cleanup: destroyInstance was called.
    const destroy = runner.calls.find((c) => c.kind === 'destroyInstance');
    expect(destroy).toBeDefined();
  });

  it('continues on compose failure (compose is not fatal)', async () => {
    const runner = new RecordingInstanceRunner();
    // Two successful results (stage, clone), then compose fails.
    runner.enqueueSyncResult({ exitCode: 0, stdout: '', stderr: '' });
    runner.enqueueSyncResult({ exitCode: 0, stdout: '', stderr: '' });
    runner.enqueueSyncResult({ exitCode: 1, stdout: '', stderr: 'compose: postgres OOM' });
    const backend = makeBackend(runner);

    const result = await backend.start(startInput());
    expect(result.ok).toBe(true);
  });

  it('reattaches to an existing handle on duplicate start', async () => {
    const runner = new RecordingInstanceRunner();
    const backend = makeBackend(runner);

    const first = await backend.start(startInput());
    const second = await backend.start(startInput());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.podId).toBe(second.value.podId);
    const creates = runner.calls.filter((c) => c.kind === 'createInstance');
    expect(creates).toHaveLength(1);
  });

  it('passes the dispatch envelope as SYMPHONY_DISPATCH_ENVELOPE on the streaming runCommand', async () => {
    const runner = new RecordingInstanceRunner();
    runner.setStreamChunks([
      {
        kind: 'data',
        stream: 'stdout',
        data: `${JSON.stringify({ kind: 'turn_completed', turnNumber: 1, at: '2026-04-30T12:00:00Z' })}\n`,
      },
      { kind: 'exit', exitCode: 0 },
    ]);
    const backend = makeBackend(runner);

    const start = await backend.start(startInput());
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    const collected: { kind: string }[] = [];
    for await (const event of start.value.events) {
      collected.push({ kind: event.kind });
    }
    expect(collected.map((e) => e.kind)).toEqual(['turn_completed']);

    const streamCall = runner.calls.find((c) => c.kind === 'runCommandStream');
    expect(streamCall).toBeDefined();
    const args = streamCall!.args as RunCommandArgs;
    expect(args.command).toEqual([
      'node',
      '/opt/symphony/packages/agent-runtime/dist/entrypoint.js',
    ]);
    expect(args.env?.['SYMPHONY_DISPATCH_ENVELOPE']).toBeDefined();
    const env = JSON.parse(args.env!['SYMPHONY_DISPATCH_ENVELOPE']!) as { issueId: string };
    expect(env.issueId).toBe('issue-id');
  });
});

describe('NamespaceBackend.stop', () => {
  it('returns ok when stopping a known handle and calls destroyInstance', async () => {
    const runner = new RecordingInstanceRunner();
    const backend = makeBackend(runner);
    const start = await backend.start(startInput());
    if (!start.ok) throw new Error('start failed');

    const result = await backend.stop(start.value);
    expect(result.ok).toBe(true);
    const destroy = runner.calls.find((c) => c.kind === 'destroyInstance');
    expect(destroy).toBeDefined();
  });

  it('returns ok (idempotent) for an unknown pod', async () => {
    const runner = new RecordingInstanceRunner();
    const backend = makeBackend(runner);
    const result = await backend.stop({
      podId: 'symphony-edu-unknown',
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.resolve({ value: undefined, done: true as const }),
          };
        },
      },
      logsTail: () => Promise.resolve(''),
    });
    expect(result.ok).toBe(true);
  });
});

describe('NamespaceBackend.ensureImage', () => {
  it('returns the configured base image with source=base', async () => {
    const runner = new RecordingInstanceRunner();
    const backend = makeBackend(runner);
    const result = await backend.ensureImage({
      projectKey: 'edu',
      preferred: 'base',
      workspacePath: '/unused',
      baseImage: 'symphony/agent-base:1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tag).toBe('symphony/agent-base:1');
    expect(result.value.source).toBe('base');
  });
});
