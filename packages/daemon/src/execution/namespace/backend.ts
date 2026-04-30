// `NamespaceBackend` — the v1 production `ExecutionBackend` per ADR 0012.
//
// Per ADR 0012 + Plan 14, each dispatch becomes one Namespace microVM
// instance. Symphony's flow:
//
//   1. `createInstance` with one container running a stock VM image
//      that has node + git + docker pre-installed.
//   2. `runCommand`: stage the agent-runtime onto the VM (v1 = `git
//      clone` + `pnpm install --prod` against the public Symphony
//      repo; future = published npm package or snapshot reuse).
//   3. `runCommand`: `git clone <repo>` + checkout the per-issue branch.
//   4. `runCommand`: `cd /workspace && docker compose up -d --wait` if
//      a `compose.yaml` / `docker-compose.yml` / `.symphony/compose.yaml`
//      exists — silently skipped otherwise.
//   5. Streaming `runCommand`: launch the agent entrypoint, yield
//      AgentEvents parsed from stdout JSON lines, end on terminal
//      event or VM exit.
//   6. `destroyInstance` on terminal event / abort / daemon shutdown.
//
// The agent runs **directly on the VM**, not inside a nested
// container. That's what makes multi-service environments work
// natively (docker compose runs on the same kernel as the agent).
//
// Idempotency contract from ADR 0011 is preserved by deriving an
// in-memory pod-name → instance-id mapping. Cross-daemon-restart
// reattach is out of scope for v1: a daemon restart loses the
// streaming runCommand handle, so the in-flight dispatch is treated
// as orphaned (the instance keeps running until its deadline, then
// auto-destroys per Namespace's `deadline` field — no leak risk).

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

import { streamAgentEvents } from './event-stream.js';
import type { InstanceRunner, InstanceShape, RunCommandChunk } from './instance-runner.js';

export interface NamespaceBackendArgs {
  /** The Namespace VM base image to start instances from. Must
   *  have node ≥ 20, git, and docker pre-installed. Configurable
   *  via `execution.namespace.base_vm_image` in symphony.yaml. */
  readonly baseImage: string;
  /** VM shape for new instances. Operator-side default; future
   *  per-project overrides land in symphony.yaml. */
  readonly shape: InstanceShape;
  /** How long, in ms, before Namespace auto-destroys an instance
   *  even if Symphony doesn't call `destroyInstance`. Hard ceiling
   *  on dispatch lifetime. */
  readonly maxLifetimeMs: number;
  /** URL of the Symphony repo to git-clone for staging the agent
   *  runtime. Public repo, read-only. The setup script runs
   *  `pnpm install --prod` against it. */
  readonly symphonyRepoUrl: string;
  /** Branch / commit ref to install the agent-runtime from.
   *  Defaults to `main`. */
  readonly symphonyRef?: string;
  readonly logger: Logger;
  /** Test seam — defaults to a real SDK-backed runner. */
  readonly runner: InstanceRunner;
}

interface ActiveHandle {
  readonly podName: string;
  readonly instanceId: string;
  readonly abortController: AbortController;
}

const STAGE_DIR = '/opt/symphony';
const WORKSPACE_DIR = '/workspace';
const AGENT_ENTRYPOINT = `${STAGE_DIR}/packages/agent-runtime/dist/entrypoint.js`;

export class NamespaceBackend implements ExecutionBackend {
  private readonly baseImage: string;
  private readonly shape: InstanceShape;
  private readonly maxLifetimeMs: number;
  private readonly symphonyRepoUrl: string;
  private readonly symphonyRef: string;
  private readonly logger: Logger;
  private readonly runner: InstanceRunner;
  private readonly activeByPod = new Map<string, ActiveHandle>();

  constructor(args: NamespaceBackendArgs) {
    this.baseImage = args.baseImage;
    this.shape = args.shape;
    this.maxLifetimeMs = args.maxLifetimeMs;
    this.symphonyRepoUrl = args.symphonyRepoUrl;
    this.symphonyRef = args.symphonyRef ?? 'main';
    this.logger = args.logger;
    this.runner = args.runner;
  }

  ensureImage(spec: ImageSpec): Promise<ExecutionResult<ImageRef>> {
    // For v1 the "image" is a stock Namespace VM base image. There's
    // no per-project image to resolve — the agent-runtime is staged
    // at runtime via `runCommand`, the team's services come from the
    // repo's compose file. Surface the configured base for diagnostics.
    return Promise.resolve({
      ok: true,
      value: {
        tag: spec.baseImage.length > 0 ? spec.baseImage : this.baseImage,
        source: 'base',
      },
    });
  }

  async start(input: PodStartInput): Promise<ExecutionResult<PodHandle>> {
    const podName = podNameFor(input.projectKey, input.issueId);
    const log = this.logger.with({
      pod_name: podName,
      project_key: input.projectKey,
      issue_id: input.issueId,
    });

    // Idempotency: in-flight dispatches reuse the existing handle.
    const existing = this.activeByPod.get(podName);
    if (existing !== undefined) {
      log.info('reattaching to existing namespace instance handle');
      return { ok: true, value: this.toHandle(existing, input.envelope) };
    }

    const abortController = new AbortController();
    const composeSignal = (): AbortSignal => {
      if (input.signal === undefined) return abortController.signal;
      const linked = new AbortController();
      const onAbort = (): void => {
        linked.abort();
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted || abortController.signal.aborted) linked.abort();
      return linked.signal;
    };

    // ---- 1. createInstance --------------------------------------
    const deadline = new Date(Date.now() + this.maxLifetimeMs);
    let instanceId: string;
    try {
      const created = await this.runner.createInstance({
        shape: this.shape,
        baseImage: this.baseImage,
        containerName: 'main',
        env: { ...input.env },
        deadline,
        documentedPurpose: `symphony dispatch ${podName}`,
      });
      instanceId = created.instanceId;
      log.info('namespace instance created', { instance_id: instanceId });
    } catch (cause) {
      return startFailed(podName, 'createInstance failed', cause);
    }

    const active: ActiveHandle = { podName, instanceId, abortController };
    this.activeByPod.set(podName, active);

    // ---- 2. waitInstance ----------------------------------------
    try {
      await this.runner.waitInstance(instanceId, composeSignal());
    } catch (cause) {
      await this.cleanupOnStartFailure(active);
      return startFailed(podName, 'waitInstance failed', cause);
    }

    // ---- 3. Stage agent-runtime onto VM -------------------------
    const stage = await this.runner.runCommandSync({
      instanceId,
      containerName: 'main',
      command: [
        'sh',
        '-c',
        [
          'set -euo pipefail',
          `mkdir -p ${STAGE_DIR}`,
          `git clone --depth=1 --branch ${shellEscape(this.symphonyRef)} ${shellEscape(this.symphonyRepoUrl)} ${STAGE_DIR}`,
          `cd ${STAGE_DIR}`,
          'corepack enable',
          'corepack prepare pnpm@10.18.2 --activate',
          'pnpm install --frozen-lockfile --filter @symphony/agent-runtime...',
          'pnpm --filter @symphony/types --filter @symphony/daemon --filter @symphony/agent-runtime build',
        ].join(' && '),
      ],
    });
    if (stage.exitCode !== 0) {
      await this.cleanupOnStartFailure(active);
      return startFailed(
        podName,
        `agent-runtime staging failed (exit ${String(stage.exitCode)}): ${stage.stderr.slice(0, 1024)}`,
        stage.stderr,
      );
    }
    log.info('agent-runtime staged on VM');

    // ---- 4. Clone target repo + checkout per-issue branch -------
    const branchName = `${input.envelope.repo.branchPrefix}${input.envelope.issueIdentifier}`;
    const clone = await this.runner.runCommandSync({
      instanceId,
      containerName: 'main',
      command: [
        'sh',
        '-c',
        [
          'set -euo pipefail',
          `mkdir -p ${WORKSPACE_DIR}`,
          `git clone ${shellEscape(input.envelope.repo.url)} ${WORKSPACE_DIR}`,
          `cd ${WORKSPACE_DIR}`,
          'git fetch origin',
          // Reuse remote branch if it exists (idempotent re-dispatch).
          `if git ls-remote --exit-code origin ${shellEscape(branchName)} >/dev/null 2>&1; then ` +
            `git checkout ${shellEscape(branchName)}; ` +
            `else git checkout -b ${shellEscape(branchName)} origin/${shellEscape(input.envelope.repo.defaultBranch)}; fi`,
        ].join(' && '),
      ],
    });
    if (clone.exitCode !== 0) {
      await this.cleanupOnStartFailure(active);
      return startFailed(
        podName,
        `git clone failed (exit ${String(clone.exitCode)}): ${clone.stderr.slice(0, 1024)}`,
        clone.stderr,
      );
    }
    log.info('target repo cloned + branch ready', { branch: branchName });

    // ---- 5. Optional: docker compose up if a compose file exists -
    const compose = await this.runner.runCommandSync({
      instanceId,
      containerName: 'main',
      command: [
        'sh',
        '-c',
        [
          'set -e',
          `cd ${WORKSPACE_DIR}`,
          // Pick first existing compose file in priority order; bail
          // (exit 0) if none found — multi-service is opt-in.
          'COMPOSE_FILE=""',
          'for f in .symphony/compose.yaml docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do ' +
            'if [ -f "$f" ]; then COMPOSE_FILE="$f"; break; fi; done',
          'if [ -z "$COMPOSE_FILE" ]; then echo "no compose file; skipping"; exit 0; fi',
          'echo "starting compose stack from $COMPOSE_FILE"',
          'docker compose -f "$COMPOSE_FILE" up -d --wait',
        ].join('\n'),
      ],
    });
    if (compose.exitCode !== 0) {
      // Compose-up failure is not fatal: the agent might still be
      // able to do useful work without the stack running. Log loud,
      // continue. The agent's prompt will see the failure when it
      // tries to hit a service and decide what to do.
      log.warn('docker compose up failed; agent will run anyway', {
        exit_code: compose.exitCode,
        stderr_tail: compose.stderr.slice(0, 512),
      });
    } else {
      log.info('compose stack up', { stdout_tail: compose.stdout.slice(-256) });
    }

    // ---- 6. Done — events stream is wired lazily on `events` access
    return { ok: true, value: this.toHandle(active, input.envelope) };
  }

  async stop(handle: PodHandle): Promise<ExecutionResult<void>> {
    const podName = handle.podId;
    const active = this.activeByPod.get(podName);
    this.activeByPod.delete(podName);
    if (active === undefined) {
      // Already gone — idempotent ok.
      return { ok: true, value: undefined };
    }
    active.abortController.abort();
    try {
      await this.runner.destroyInstance(active.instanceId, 'symphony stop');
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'pod_stop_failed',
          message: `destroyInstance failed: ${stringify(cause)}`,
          podName,
          cause,
        },
      };
    }
  }

  // ---- internals ------------------------------------------------------

  private toHandle(active: ActiveHandle, envelope: DispatchEnvelope): PodHandle {
    const runArgs = {
      instanceId: active.instanceId,
      containerName: 'main',
      command: ['node', AGENT_ENTRYPOINT],
      cwd: WORKSPACE_DIR,
      env: {
        SYMPHONY_DISPATCH_ENVELOPE: JSON.stringify(envelope),
      },
    } as const;
    return {
      podId: active.podName,
      events: streamAgentEvents(this.runner, runArgs, active.abortController.signal),
      logsTail: () => this.tailLogs(active.instanceId),
    };
  }

  private async tailLogs(instanceId: string): Promise<string> {
    // Best-effort: a one-shot `runCommandSync` to grab whatever
    // recent stdio Namespace's observability layer would surface.
    // For v1 just dump `journalctl` or fall through to a marker;
    // the streaming runCommand on the agent process is the real
    // source of truth, this is purely a diagnostic safety net.
    try {
      const result = await this.runner.runCommandSync({
        instanceId,
        containerName: 'main',
        command: ['sh', '-c', 'tail -n 200 /var/log/symphony-agent.log 2>/dev/null || true'],
      });
      return `${result.stdout}\n${result.stderr}`;
    } catch (cause) {
      return `<logsTail failed: ${stringify(cause)}>`;
    }
  }

  private async cleanupOnStartFailure(active: ActiveHandle): Promise<void> {
    this.activeByPod.delete(active.podName);
    try {
      await this.runner.destroyInstance(active.instanceId, 'symphony start aborted');
    } catch {
      // Best-effort: if cleanup fails, the deadline catches it.
    }
  }
}

// ---- helpers --------------------------------------------------------

function startFailed(podName: string, message: string, cause: unknown): ExecutionResult<PodHandle> {
  return {
    ok: false,
    error: {
      code: 'pod_start_failed',
      message,
      podName,
      cause,
    },
  };
}

function stringify(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Single-quote-escape a string for safe inclusion in a `sh -c`
 * command. We avoid template-string interpolation for any value
 * that could contain shell metacharacters.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// Re-exported so tests can poke at the internals if needed.
export type { RunCommandChunk };
