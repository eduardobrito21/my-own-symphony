// Per-workspace Docker container lifecycle.
//
// Plan 10: each Linear issue's workspace is backed by a long-lived
// Docker container. The daemon (a Node process on the host) shells
// out to the `docker` CLI to start the container at workspace prep
// time, exec into it for the agent's shell calls, and remove it at
// terminal cleanup.
//
// We deliberately use the `docker` CLI rather than a Docker SDK:
//   - the CLI is stable across host platforms (Docker Desktop on
//     macOS / Windows, plain `docker` on Linux),
//   - no native deps to bundle into our distribution,
//   - errors are operator-readable (you can copy-paste the failing
//     command from a log line).
//
// All `docker` invocations go through `runDocker`, a thin wrapper
// over `child_process.spawn` that's injectable for tests. The
// production injection in the composition root uses the real spawn;
// tests inject a mock that returns canned stdout / exit codes.

import { spawn, type SpawnOptions } from 'node:child_process';

import type { Logger } from '../observability/index.js';

/**
 * Result of executing a `docker` (or `docker exec`) invocation.
 * Modeled as a discriminated union so callers can branch on success
 * without unwrapping nested errors.
 */
export type DockerResult =
  | { readonly ok: true; readonly exitCode: 0; readonly stdout: string; readonly stderr: string }
  | {
      readonly ok: false;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly signal: NodeJS.Signals | null;
    };

/**
 * Runs a `docker ...` command. Injectable via `WorkspaceContainerArgs.runDocker`
 * so tests can stub the boundary cleanly.
 *
 * The signature deliberately accepts `args: readonly string[]` rather
 * than a single command string — this prevents shell-injection bugs
 * if a workspace identifier ever contains weird characters.
 * `sanitizeIdentifier` already constrains those, but defense in
 * depth is cheap.
 */
export type DockerRunner = (
  args: readonly string[],
  options?: { readonly stdin?: string; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => Promise<DockerResult>;

export interface WorkspaceContainerArgs {
  /** Sanitized DNS-safe key, e.g. `EDU-5`. Used in the container name. */
  readonly key: string;
  /** Absolute host path of the workspace dir to bind into /workspace. */
  readonly workspacePath: string;
  /** Image to launch. Default `symphony/agent:dev`. */
  readonly image?: string;
  /** Extra env vars to set inside the container at `docker run` time. */
  readonly env?: Readonly<Record<string, string>>;
  /** UID:GID to run as. Defaults to 1000:1000 (matches the image's `agent` user). */
  readonly user?: string;
  readonly logger: Logger;
  /** Test seam — defaults to a real `docker` spawn. */
  readonly runDocker?: DockerRunner;
}

const DEFAULT_IMAGE = 'symphony/agent:dev';
const CONTAINER_NAME_PREFIX = 'symphony-';

/**
 * One per workspace. Owns the container lifecycle: ensureRunning →
 * (many) exec → destroy.
 *
 * Idempotent: `ensureRunning` is safe to call repeatedly; the second
 * call short-circuits if the container is already up.
 */
export class WorkspaceContainer {
  readonly name: string;
  private readonly workspacePath: string;
  private readonly image: string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly user: string;
  private readonly logger: Logger;
  private readonly runDocker: DockerRunner;

  constructor(args: WorkspaceContainerArgs) {
    this.name = `${CONTAINER_NAME_PREFIX}${args.key}`;
    this.workspacePath = args.workspacePath;
    this.image = args.image ?? DEFAULT_IMAGE;
    this.env = args.env ?? {};
    this.user = args.user ?? '1000:1000';
    this.logger = args.logger;
    this.runDocker = args.runDocker ?? defaultRunDocker;
  }

  /**
   * Ensure the container exists and is running. Three states are possible:
   *
   *   - missing       → `docker run -d ...`
   *   - exists+stopped → `docker start <name>`
   *   - exists+running → no-op
   *
   * We use `docker inspect` (single command, parseable JSON output)
   * to disambiguate.
   */
  async ensureRunning(): Promise<DockerResult> {
    const inspect = await this.runDocker(['inspect', '--format={{.State.Running}}', this.name]);

    if (inspect.ok && inspect.stdout.trim() === 'true') {
      this.logger.info('container already running', { container: this.name });
      return inspect;
    }
    if (inspect.ok && inspect.stdout.trim() === 'false') {
      this.logger.info('container exists but stopped; starting', { container: this.name });
      return await this.runDocker(['start', this.name]);
    }

    // `docker inspect` non-zero usually means "no such container" —
    // create one. (We don't try to distinguish that from real
    // failures here; if `docker run` also fails the operator gets
    // both error messages in the logs.)
    return await this.runFresh();
  }

  /**
   * Run a command inside the container. Returns a `DockerResult` so
   * the caller can branch on success without exception handling.
   *
   * `stdin` (optional) is piped to the command. Useful for
   * `git commit -F -` style invocations.
   */
  async exec(
    command: string,
    args: readonly string[],
    options: { readonly env?: Readonly<Record<string, string>>; readonly stdin?: string } = {},
  ): Promise<DockerResult> {
    const dockerArgs: string[] = ['exec'];
    if (options.stdin !== undefined) dockerArgs.push('-i');
    if (options.env !== undefined) {
      for (const [k, v] of Object.entries(options.env)) {
        dockerArgs.push('--env', `${k}=${v}`);
      }
    }
    dockerArgs.push(this.name, command, ...args);
    return await this.runDocker(
      dockerArgs,
      options.stdin === undefined ? {} : { stdin: options.stdin },
    );
  }

  /**
   * Destroy the container. Best-effort: a missing container is not
   * an error (we may have crashed mid-cleanup last run). Any other
   * failure is logged but not thrown — workspace removal must not
   * be blocked by container teardown trouble.
   */
  async destroy(): Promise<void> {
    const result = await this.runDocker(['rm', '-f', this.name]);
    if (!result.ok) {
      this.logger.warn('container removal failed (ignored)', {
        container: this.name,
        exit_code: result.exitCode,
        stderr: tail(result.stderr, 512),
      });
    }
  }

  private async runFresh(): Promise<DockerResult> {
    const args = [
      'run',
      '-d',
      '--name',
      this.name,
      '--user',
      this.user,
      '-v',
      `${this.workspacePath}:/workspace`,
      '-w',
      '/workspace',
    ];
    for (const [k, v] of Object.entries(this.env)) {
      args.push('--env', `${k}=${v}`);
    }
    args.push(this.image);
    this.logger.info('starting fresh container', {
      container: this.name,
      image: this.image,
      workspace_path: this.workspacePath,
    });
    return await this.runDocker(args);
  }
}

// ---------------------------------------------------------------------
// Default real-`docker`-CLI runner.

const defaultRunDocker: DockerRunner = (args, options = {}) => {
  return new Promise<DockerResult>((resolve) => {
    const spawnOptions: SpawnOptions = {
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.env !== undefined) spawnOptions.env = options.env;
    const child = spawn('docker', args.slice(), spawnOptions);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => {
      stdoutChunks.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrChunks.push(c);
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(options.stdin);
    }
    child.on('error', (cause) => {
      // Spawn-time failure (docker not installed, PATH issue, etc.).
      // Surface as a non-ok DockerResult with -1 exit so callers
      // don't need a separate try/catch path.
      resolve({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: cause instanceof Error ? cause.message : String(cause),
        signal: null,
      });
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ ok: true, exitCode: 0, stdout, stderr });
        return;
      }
      resolve({
        ok: false,
        exitCode: code ?? -1,
        stdout,
        stderr,
        signal,
      });
    });
  });
};

function tail(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return `…${s.slice(-maxBytes)}`;
}
