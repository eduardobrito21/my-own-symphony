// Test seam over the Namespace SDK's compute + command APIs.
//
// The seam exists for the same reason `LocalDockerBackend` has its
// own `DockerRunner` interface: the backend logic is meaningfully
// testable with an in-memory mock. Tests use a `RecordingInstanceRunner`
// (in `backend.test.ts`); the composition root constructs the real
// SDK-backed impl via `createNamespaceInstanceRunner` (in
// `sdk-runner.ts`).
//
// Keeping the SDK imports out of this file means `pnpm typecheck`
// works even when only the interface is imported, and unit tests
// don't pull `@connectrpc/connect` into the test bundle.

export interface InstanceShape {
  /** Virtual CPUs. Maps to `Shape.virtualCpu`. */
  readonly vcpu: number;
  /** Memory in megabytes. Maps to `Shape.memoryMegabytes`. */
  readonly memoryMb: number;
  /** Architecture. Maps to `Shape.machineArch`. */
  readonly arch: 'amd64' | 'arm64';
}

export interface CreateInstanceArgs {
  readonly shape: InstanceShape;
  /** Image ref (e.g. `ubuntu:24.04`) for the single container we
   *  start the instance with. The agent itself runs as a process
   *  inside this container — not its own container. */
  readonly baseImage: string;
  /** Logical name for the container Namespace runs (a single one
   *  per instance, by convention `main`). Used as
   *  `target_container_name` on subsequent `runCommand` calls. */
  readonly containerName: string;
  /** Env vars to set on the container at start. Symphony adds
   *  `LINEAR_API_KEY` etc. here so they're available to every
   *  subsequent `runCommand`. */
  readonly env: Readonly<Record<string, string>>;
  /** When the instance must auto-destroy. Namespace's
   *  `deadline` field — bounded lifetime so a daemon crash
   *  doesn't leak a VM. */
  readonly deadline: Date;
  /** Audit-log string surfaced in Namespace's UI. */
  readonly documentedPurpose: string;
}

export interface RunCommandArgs {
  readonly instanceId: string;
  readonly containerName: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  /** Per-command env. Merged on top of (and overrides) the
   *  container-level env set at create time. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface RunCommandSyncResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A single chunk yielded by the streaming `runCommand`. Either a
 *  byte chunk on stdout/stderr, or the terminal `exitCode`. */
export type RunCommandChunk =
  | { readonly kind: 'data'; readonly stream: 'stdout' | 'stderr'; readonly data: string }
  | { readonly kind: 'exit'; readonly exitCode: number };

export interface InstanceRunner {
  /** Create + return the instance id. Resolves once Namespace has
   *  accepted the request (NOT when the instance is actually
   *  ready; use `waitInstance` after for that). */
  createInstance(args: CreateInstanceArgs): Promise<{ instanceId: string }>;

  /** Block until the instance is ready for `runCommand`. */
  waitInstance(instanceId: string, signal?: AbortSignal): Promise<void>;

  /** Unary-style exec — for short-lived setup commands (clone,
   *  install, compose-up). Resolves with the full stdout/stderr +
   *  exit code. */
  runCommandSync(args: RunCommandArgs): Promise<RunCommandSyncResult>;

  /** Server-streaming exec — for the long-running agent process.
   *  Yields stdout/stderr chunks as they arrive, then a final
   *  `exit` chunk. The signal aborts the underlying RPC. */
  runCommandStream(args: RunCommandArgs, signal?: AbortSignal): AsyncIterable<RunCommandChunk>;

  /** Tear down. Idempotent — already-destroyed is ok. */
  destroyInstance(instanceId: string, reason: string): Promise<void>;
}

export interface NamespaceRunnerOptions {
  /** Region passed to `createComputeClient`. Defaults to `'us'`. */
  readonly region?: string;
}
