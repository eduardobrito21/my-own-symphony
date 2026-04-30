// Shared `docker` CLI runner for `LocalDockerBackend`.
//
// Re-exports the existing `DockerRunner` type from
// `workspace/container.ts` (the cross-cutting CLI shape; not coupled
// to the workspace layer's logic) and provides a real-spawn default.
// Tests inject a mock the same way `WorkspaceContainer` tests do.
//
// We don't depend on `workspace/container.ts` directly because the
// dependency-cruiser layer rules forbid `execution/` from importing
// `workspace/`. The shape is small enough to live in both places; the
// runtime semantics are identical.

import { spawn, type SpawnOptions } from 'node:child_process';

export type DockerResult =
  | { readonly ok: true; readonly exitCode: 0; readonly stdout: string; readonly stderr: string }
  | {
      readonly ok: false;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly signal: NodeJS.Signals | null;
    };

export type DockerRunner = (
  args: readonly string[],
  options?: { readonly stdin?: string; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => Promise<DockerResult>;

export const defaultDockerRunner: DockerRunner = (args, options = {}) => {
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
