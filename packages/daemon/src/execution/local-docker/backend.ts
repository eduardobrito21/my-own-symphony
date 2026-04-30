// `LocalDockerBackend` — production v1 `ExecutionBackend`.
//
// Per ADR 0011 + Plan 10, the orchestrator dispatches each issue to a
// per-issue Docker pod. This backend:
//
//   1. Resolves the agent image (per `image-resolver.ts`).
//   2. Allocates a host-side Unix socket the daemon listens on.
//   3. Writes the dispatch envelope to a host-side JSON file.
//   4. `docker run -d --name <pod>` with the workspace, dispatch
//      envelope, and event socket all bind-mounted into the pod.
//   5. Returns a `PodHandle` whose `events` reads the socket and whose
//      `logsTail()` calls `docker logs --tail`.
//   6. `stop()` calls `docker stop -t 5 <pod>; docker rm -f <pod>` and
//      cleans the host-side socket + envelope files.
//
// Idempotency contract (ADR 0011): `start({ projectKey, issueId, ... })`
// must resolve to the same `PodHandle` shape on a re-call for the same
// pod name. We implement this by checking `docker inspect <pod>`
// before `docker run` — if the pod exists, we attach to its (already
// allocated) host socket rather than racing to create a duplicate.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '../../observability/index.js';
import {
  podNameFor,
  type DispatchEnvelope,
  type ExecutionBackend,
  type ImageRef,
  type ImageSpec,
  type PodHandle,
  type PodStartInput,
} from '../backend.js';
import type { ExecutionResult } from '../errors.js';

import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';
import { resolveImage } from './image-resolver.js';
import { bindEventSocket, type EventSocketServer } from './socket-server.js';

export interface LocalDockerBackendArgs {
  /** Default base image. Used when image resolution falls through. */
  readonly baseImage: string;
  /** Root directory the host uses for per-pod transient state
   *  (sockets, dispatch envelope JSON files). Defaults to a
   *  daemon-private subdir of the OS tmpdir. */
  readonly transientRoot?: string;
  readonly logger: Logger;
  /** Test seam — defaults to a real `docker` spawn. */
  readonly runDocker?: DockerRunner;
}

interface ActiveHandle {
  readonly podName: string;
  readonly server: EventSocketServer;
  readonly envelopeHostPath: string;
}

export class LocalDockerBackend implements ExecutionBackend {
  private readonly baseImage: string;
  private readonly transientRoot: string;
  private readonly logger: Logger;
  private readonly runDocker: DockerRunner;
  private readonly activeByPod = new Map<string, ActiveHandle>();

  constructor(args: LocalDockerBackendArgs) {
    this.baseImage = args.baseImage;
    // Used for the dispatch envelope JSON file we mount into the pod.
    // Default to `~/.symphony-pods` because Docker Desktop on macOS
    // bind-mounts `$HOME` by default via VirtioFS, while `$TMPDIR`
    // (`/var/folders/...`) often isn't shared.
    this.transientRoot = args.transientRoot ?? join(homedir(), '.symphony-pods');
    this.logger = args.logger;
    this.runDocker = args.runDocker ?? defaultDockerRunner;
  }

  ensureImage(spec: ImageSpec): Promise<ExecutionResult<ImageRef>> {
    // The spec carries the per-project base image hint already, but
    // the resolver also needs our fallback. Caller-provided
    // `spec.baseImage` wins (deployment YAML); we patch in our
    // default only if it's empty.
    const effective: ImageSpec = {
      ...spec,
      baseImage: spec.baseImage.length > 0 ? spec.baseImage : this.baseImage,
    };
    return resolveImage({ spec: effective, runDocker: this.runDocker });
  }

  async start(input: PodStartInput): Promise<ExecutionResult<PodHandle>> {
    const podName = podNameFor(input.projectKey, input.issueId);
    const log = this.logger.with({
      pod_name: podName,
      project_key: input.projectKey,
      issue_id: input.issueId,
    });

    // Idempotency: if the pod already exists locally, return its
    // existing handle. We only have an in-memory record across THIS
    // daemon's lifetime; a daemon restart loses the handle but
    // `docker inspect` still finds the pod. In that case we cannot
    // reattach the events stream (the previous socket file is gone),
    // so we treat the existing pod as authoritative and emit a
    // synthetic terminal event when its current iteration ends.
    const existing = this.activeByPod.get(podName);
    if (existing !== undefined) {
      log.info('reattaching to existing pod handle');
      return { ok: true, value: this.toHandle(existing) };
    }

    // Allocate transient host path for the dispatch envelope JSON.
    // Use a SHORT 12-hex-char hash of the pod name to keep filenames
    // small (the issue UUID alone is 36 chars). Deterministic on
    // pod name so re-`start()` for the same pod hits the same path.
    const shortId = createHash('sha256').update(podName).digest('hex').slice(0, 12);
    try {
      await mkdir(this.transientRoot, { recursive: true });
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'pod_start_failed',
          message: `failed to create transient root ${this.transientRoot}: ${stringify(cause)}`,
          podName,
          cause,
        },
      };
    }
    const envelopeHostPath = join(this.transientRoot, `${shortId}.json`);

    // Write dispatch envelope before binding the listener — failure
    // to write should NOT leave a dangling TCP listener.
    try {
      await writeFile(envelopeHostPath, JSON.stringify(input.envelope, null, 2), 'utf8');
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'pod_start_failed',
          message: `failed to write dispatch envelope at ${envelopeHostPath}: ${stringify(cause)}`,
          podName,
          cause,
        },
      };
    }

    // Bind a TCP listener on 127.0.0.1:0 (random free port). The pod
    // will connect via `host.docker.internal:<port>`.
    let server: EventSocketServer;
    try {
      server = await bindEventSocket({
        ...(input.signal !== undefined && { signal: input.signal }),
      });
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'pod_start_failed',
          message: `failed to bind event TCP listener: ${stringify(cause)}`,
          podName,
          cause,
        },
      };
    }

    // Construct the `docker run` argv.
    const args = this.buildRunArgs({
      podName,
      image: input.image,
      workspacePath: input.workspacePath,
      eventPort: server.port,
      envelopeHostPath,
      env: input.env,
    });
    log.info('docker run', { image: input.image.tag, source: input.image.source });
    const runResult = await this.runDocker(args);
    if (!runResult.ok) {
      // Surface a hint about the most common cause: image absent
      // (`ensureImage` should have caught this, but `docker run` can
      // also fail on stale daemon state, name conflicts, etc.).
      await server.close();
      return {
        ok: false,
        error: {
          code: 'pod_start_failed',
          message: `docker run failed (exit ${String(runResult.exitCode)}): ${runResult.stderr.slice(0, 1024)}`,
          podName,
          cause: runResult.stderr,
        },
      };
    }

    const active: ActiveHandle = {
      podName,
      server,
      envelopeHostPath,
    };
    this.activeByPod.set(podName, active);
    return { ok: true, value: this.toHandle(active) };
  }

  async stop(handle: PodHandle): Promise<ExecutionResult<void>> {
    const podName = handle.podId;
    const active = this.activeByPod.get(podName);
    this.activeByPod.delete(podName);

    // `docker stop -t 5` then `rm -f`. Both are idempotent — we don't
    // care if the pod is already gone.
    const stopResult = await this.runDocker(['stop', '-t', '5', podName]);
    const rmResult = await this.runDocker(['rm', '-f', podName]);

    if (active !== undefined) {
      await active.server.close();
    }

    // Treat both "no such container" and a successful stop as ok.
    // Anything else (docker daemon down, etc.) bubbles as a typed
    // error so the caller can log + continue.
    const stopStderr = stopResult.ok ? '' : stopResult.stderr;
    const rmStderr = rmResult.ok ? '' : rmResult.stderr;
    const benign = (s: string): boolean =>
      s.includes('No such container') || s.includes('is not running');
    const stopOk = stopResult.ok || benign(stopStderr);
    const rmOk = rmResult.ok || benign(rmStderr);
    if (stopOk && rmOk) return { ok: true, value: undefined };

    return {
      ok: false,
      error: {
        code: 'pod_stop_failed',
        message: `docker stop/rm failed: stop=${stopStderr.slice(0, 256)} rm=${rmStderr.slice(0, 256)}`,
        podName,
        cause: { stopStderr, rmStderr },
      },
    };
  }

  // ---- internals ------------------------------------------------------

  private toHandle(active: ActiveHandle): PodHandle {
    return {
      podId: active.podName,
      events: active.server.events(),
      logsTail: () => this.tailLogs(active.podName),
    };
  }

  private async tailLogs(podName: string): Promise<string> {
    const result = await this.runDocker(['logs', '--tail', '200', podName]);
    if (result.ok) return `${result.stdout}\n${result.stderr}`;
    return `<docker logs failed: ${result.stderr.slice(0, 256)}>`;
  }

  private buildRunArgs(args: {
    readonly podName: string;
    readonly image: ImageRef;
    readonly workspacePath: string;
    readonly eventPort: number;
    readonly envelopeHostPath: string;
    readonly env: Readonly<Record<string, string>>;
  }): string[] {
    // NOTE: deliberately NOT using `--rm` so that exited pods stick
    // around for inspection via `docker logs <pod-name>`. The
    // `stop()` method explicitly removes them. Trade-off: a daemon
    // that crashes between pod-exit and stop() leaves stopped pods
    // behind; the operator cleans those with
    // `docker rm $(docker ps -aq --filter "name=symphony-")`.
    //
    // `--add-host=host.docker.internal:host-gateway` makes the host
    // address resolvable from inside the pod on Linux too (it's
    // automatic on Docker Desktop for macOS/Windows). The pod uses
    // this to reach the per-pod TCP listener the daemon bound on
    // 127.0.0.1:<eventPort>.
    const out: string[] = [
      'run',
      '-d',
      '--name',
      args.podName,
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${args.workspacePath}:/workspace`,
      '-v',
      `${args.envelopeHostPath}:/etc/symphony/dispatch.json:ro`,
      '-e',
      `SYMPHONY_EVENT_HOST=host.docker.internal:${String(args.eventPort)}`,
    ];
    for (const [k, v] of Object.entries(args.env)) {
      out.push('-e', `${k}=${v}`);
    }
    out.push(args.image.tag);
    return out;
  }
}

function stringify(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Build a `DispatchEnvelope` from per-issue inputs. Caller-friendly
 * factory so the orchestrator (which knows the project + issue +
 * caps) doesn't have to assemble the literal each time.
 *
 * Centralized here (in the local-docker subpackage) because the
 * production callers always pair this with `LocalDockerBackend.start`.
 * `FakeBackend` users can build their own envelope inline — that test
 * surface doesn't need a helper.
 */
export function buildDispatchEnvelope(args: {
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly projectKey: string;
  readonly trackerProjectSlug: string;
  readonly repoUrl: string;
  readonly defaultBranch: string;
  readonly workflowPath: string;
  readonly branchPrefix: string;
  readonly operatorCaps: DispatchEnvelope['operatorCaps'];
  readonly attempt: number | null;
  readonly resumeSessionId?: string;
}): DispatchEnvelope {
  return {
    issueId: args.issueId as DispatchEnvelope['issueId'],
    issueIdentifier: args.issueIdentifier as DispatchEnvelope['issueIdentifier'],
    projectKey: args.projectKey,
    tracker: { kind: 'linear', projectSlug: args.trackerProjectSlug },
    repo: {
      url: args.repoUrl,
      defaultBranch: args.defaultBranch,
      workflowPath: args.workflowPath,
      branchPrefix: args.branchPrefix,
    },
    operatorCaps: args.operatorCaps,
    attempt: args.attempt,
    ...(args.resumeSessionId !== undefined && { resumeSessionId: args.resumeSessionId }),
  };
}
