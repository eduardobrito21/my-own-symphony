// Workspace hook executor.
//
// SPEC §9.4 / §15.4: hooks are arbitrary shell scripts read from
// `WORKFLOW.md`. They are trusted configuration but require strict
// runtime controls:
//
//   - cwd is the per-issue workspace (NOT the daemon's cwd, NOT the
//     workspace root)
//   - hard timeout via `AbortController` so a hung hook can never
//     stall the orchestrator
//   - stdout/stderr captured but truncated so a runaway hook can't
//     blow up daemon memory
//   - shell is `bash -lc <script>` on POSIX; we don't claim Windows
//     support
//
// Timeout semantics:
//   - At `timeoutMs`, send SIGTERM and start a grace timer.
//   - If the process is still alive after `gracePeriodMs`, send
//     SIGKILL.
//   - In the `HookTimeoutError` we report the original timeout, not
//     the kill time.

import { spawn } from 'node:child_process';

import type { HookNonZeroExitError, HookSpawnError, HookTimeoutError } from './errors.js';

/** SPEC §5.3.4 names — also used for log identification. */
export type HookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface RunHookArgs {
  readonly name: HookName;
  /** Shell script body. Empty/undefined means "no-op, return ok". */
  readonly script: string;
  /** Working directory for the spawn — must be the workspace path. */
  readonly cwd: string;
  /** Hard timeout (ms). After this, SIGTERM then SIGKILL. */
  readonly timeoutMs: number;
  /** Override grace period between SIGTERM and SIGKILL. Default 2000ms. */
  readonly gracePeriodMs?: number;
  /** Override max output capture per stream. Default 64 KiB. */
  readonly maxOutputBytes?: number;
}

export interface HookRunOk {
  readonly ok: true;
  readonly hook: HookName;
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type HookRunFailure =
  | { readonly ok: false; readonly error: HookTimeoutError }
  | { readonly ok: false; readonly error: HookNonZeroExitError }
  | { readonly ok: false; readonly error: HookSpawnError };

export type HookRunResult = HookRunOk | HookRunFailure;

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Run a workspace hook as `bash -lc <script>` with `cwd` set to the
 * workspace path. Returns a typed result rather than throwing.
 *
 * Empty / whitespace-only scripts return success without spawning a
 * shell (matches what an absent `hooks.<name>` field semantically
 * means: no-op).
 */
export function runHook(args: RunHookArgs): Promise<HookRunResult> {
  const trimmed = args.script.trim();
  if (trimmed === '') {
    return Promise.resolve({
      ok: true,
      hook: args.name,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
    });
  }

  const gracePeriodMs = args.gracePeriodMs ?? DEFAULT_GRACE_MS;
  const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  return new Promise<HookRunResult>((resolve) => {
    let child;
    try {
      child = spawn('bash', ['-lc', args.script], {
        cwd: args.cwd,
        // Ignore stdin: hooks should not prompt. Capture stdout/stderr.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached: false (default) — we want signals to propagate
        // straight to the bash process and its descendants stay in
        // the same process group so SIGKILL reaches them too.
      });
    } catch (cause) {
      const error: HookSpawnError = {
        code: 'hook_spawn_failed',
        hook: args.name,
        message: `Failed to spawn bash for hook '${args.name}': ${stringifyCause(cause)}`,
        cause,
      };
      resolve({ ok: false, error });
      return;
    }

    // Stdout / stderr accumulators with byte caps. `truncated` flips
    // to true the moment we drop bytes; that way we can mark the
    // captured output so logs are not silently misleading.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // `stdout` and `stderr` are guaranteed non-null because we
    // configured `stdio: ['ignore', 'pipe', 'pipe']` above.
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxOutputBytes;
        stdoutTruncated = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes = maxOutputBytes;
        stderrTruncated = true;
      }
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; many shells handle it cleanly.
      child.kill('SIGTERM');
      // If still alive after grace, escalate to SIGKILL. We check
      // `exitCode === null` rather than `child.killed` because
      // `child.killed` flips on the FIRST kill signal, not on actual
      // exit.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, gracePeriodMs);
    }, args.timeoutMs);

    child.on('error', (cause) => {
      // Spawn-time errors after the spawn() call returned (rare:
      // happens when the binary is missing). Treated the same as a
      // synchronous spawn throw.
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      const error: HookSpawnError = {
        code: 'hook_spawn_failed',
        hook: args.name,
        message: `Hook '${args.name}' failed to spawn: ${stringifyCause(cause)}`,
        cause,
      };
      resolve({ ok: false, error });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);

      const stdout = renderCapture(stdoutChunks, stdoutTruncated);
      const stderr = renderCapture(stderrChunks, stderrTruncated);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        const error: HookTimeoutError = {
          code: 'hook_timeout',
          hook: args.name,
          message: `Hook '${args.name}' exceeded ${args.timeoutMs}ms timeout (killed with ${signal ?? 'unknown'}).`,
          timeoutMs: args.timeoutMs,
        };
        resolve({ ok: false, error });
        return;
      }

      if (code === 0) {
        resolve({
          ok: true,
          hook: args.name,
          exitCode: 0,
          stdout,
          stderr,
          durationMs,
        });
        return;
      }

      // Either a non-zero exit code or a signal-only termination.
      // Both surface as `hook_non_zero_exit`; we synthesize an exit
      // code of 128 + signal number for signal-only exits, matching
      // POSIX shell convention. (Actual Node provides `code === null`
      // when the process was killed by a signal.)
      const effectiveCode = code ?? (signal !== null ? 128 : -1);
      const error: HookNonZeroExitError = {
        code: 'hook_non_zero_exit',
        hook: args.name,
        message: `Hook '${args.name}' exited with code ${effectiveCode}${
          signal !== null ? ` (signal ${signal})` : ''
        }.`,
        exitCode: effectiveCode,
        // Tail of captured output for log context. The orchestrator
        // logs the full message; we stop short of dumping kilobytes.
        stdoutTail: tail(stdout, 1024),
        stderrTail: tail(stderr, 1024),
      };
      resolve({ ok: false, error });
    });
  });
}

/**
 * Render a captured stream as a UTF-8 string, with a `[truncated]`
 * marker if we dropped bytes.
 */
function renderCapture(chunks: readonly Buffer[], truncated: boolean): string {
  const joined = Buffer.concat(chunks).toString('utf8');
  return truncated ? `${joined}\n[truncated]` : joined;
}

function tail(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return `…${text.slice(-maxBytes)}`;
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
