// `WorkspaceManager` — the layer's public surface.
//
// Composes `paths.ts`, `hooks.ts`, and a few `node:fs/promises`
// primitives into the lifecycle the orchestrator wants:
//
//   prepareForRun(identifier)
//     -> createForIssue (mkdir + after_create on first creation)
//     -> before_run
//     -> Workspace
//
//   finalizeAfterRun(workspace)
//     -> after_run (best effort; failures logged, not thrown)
//
//   removeForTerminal(identifier)
//     -> before_remove (best effort)
//     -> rm -rf
//
// SPEC §9.4 failure semantics:
//   - after_create / before_run failures are FATAL to this attempt.
//     We surface them as Result errors so the orchestrator can retry.
//   - after_run / before_remove failures are LOGGED and IGNORED so a
//     broken cleanup hook can't block progress.
//
// Per-issue concurrency: the orchestrator's own claim system prevents
// two workers running on the same issue at once, but tests and
// pathological cases could double-call `createForIssue`. We use
// non-recursive `mkdir` to make creation atomic at the FS layer and
// detect the EEXIST race cleanly.

import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { HooksConfig } from '../config/schema.js';
import { sanitizeIdentifier, type IssueIdentifier, type Workspace } from '../types/index.js';

import type {
  WorkspaceCreationError,
  WorkspaceError,
  WorkspaceNotADirectoryError,
} from './errors.js';
import { runHook, type HookName, type HookRunFailure } from './hooks.js';
import { WorkspaceContainmentException, workspacePathFor } from './paths.js';

export type CreateResult =
  | { readonly ok: true; readonly workspace: Workspace }
  | { readonly ok: false; readonly error: WorkspaceError };

export type PrepareResult = CreateResult;

export interface WorkspaceManagerArgs {
  /** Absolute path to `workspace.root`. */
  readonly root: string;
  readonly hooks: HooksConfig;
  /**
   * Optional logger for best-effort hook failures. Defaults to a
   * no-op so tests don't have to inject one. Plan 04+ wires the real
   * `pino` logger via the composition root.
   */
  readonly logger?: WorkspaceLogger;
}

export interface WorkspaceLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: WorkspaceLogger = {
  // No-op logger: drops messages on the floor. Plan 04+ wires the real
  // `pino` logger via the composition root.
  warn() {
    /* intentionally empty */
  },
  error() {
    /* intentionally empty */
  },
};

export class WorkspaceManager {
  private readonly root: string;
  // Mutable so dynamic `WORKFLOW.md` reload (Plan 05) can swap hook
  // scripts and timeout in place without recreating the manager.
  // Reads always go through `this.hooks.<field>`; we never close
  // over the value at method-define time.
  private hooks: HooksConfig;
  private readonly logger: WorkspaceLogger;

  constructor(args: WorkspaceManagerArgs) {
    this.root = args.root;
    this.hooks = args.hooks;
    this.logger = args.logger ?? NOOP_LOGGER;
  }

  /**
   * Replace the live hook config. Used by the orchestrator when
   * `WORKFLOW.md` is reloaded so future runs use the new scripts /
   * timeout. In-flight hooks already running keep their original
   * values (we don't try to re-target a process mid-execution).
   */
  setHooks(hooks: HooksConfig): void {
    this.hooks = hooks;
  }

  /**
   * Compute the workspace path without touching the filesystem.
   * Useful for the agent runner's pre-launch `cwd === workspacePath`
   * sanity check (SPEC §15.2 invariant 1).
   */
  pathFor(identifier: IssueIdentifier): string {
    return workspacePathFor(this.root, identifier);
  }

  /**
   * Ensure the per-issue workspace directory exists. Runs the
   * `after_create` hook only when the directory is freshly created.
   * Reusing an existing workspace is the common case (workspaces are
   * preserved across runs per SPEC §9.1).
   */
  async createForIssue(identifier: IssueIdentifier): Promise<CreateResult> {
    let path: string;
    try {
      path = workspacePathFor(this.root, identifier);
    } catch (cause) {
      // workspacePathFor throws a `WorkspaceContainmentException` that
      // carries a typed `WorkspaceContainmentError` payload. Lift the
      // payload into our Result error union; rethrow anything else.
      if (cause instanceof WorkspaceContainmentException) {
        return { ok: false, error: cause.payload };
      }
      throw cause;
    }

    const createResult = await ensureDirectoryAtomic(path);
    if (!createResult.ok) {
      return { ok: false, error: createResult.error };
    }

    const workspace: Workspace = {
      path,
      key: sanitizeIdentifier(identifier),
      createdNow: createResult.createdNow,
    };

    if (workspace.createdNow && this.hooks.after_create !== undefined) {
      const hookResult = await runHook({
        name: 'after_create',
        script: this.hooks.after_create,
        cwd: path,
        timeoutMs: this.hooks.timeout_ms,
      });
      if (!hookResult.ok) {
        // SPEC §9.4: after_create failure is fatal to creation.
        // We do not roll back the directory — leaving it lets the
        // operator inspect post-mortem. The orchestrator will retry.
        return { ok: false, error: failureToError(hookResult) };
      }
    }

    return { ok: true, workspace };
  }

  /**
   * Full pre-run lifecycle: create (or reuse) the workspace, run
   * `before_run`. Used by the orchestrator's worker before launching
   * the agent.
   */
  async prepareForRun(identifier: IssueIdentifier): Promise<PrepareResult> {
    const created = await this.createForIssue(identifier);
    if (!created.ok) return created;

    if (this.hooks.before_run !== undefined) {
      const hookResult = await runHook({
        name: 'before_run',
        script: this.hooks.before_run,
        cwd: created.workspace.path,
        timeoutMs: this.hooks.timeout_ms,
      });
      if (!hookResult.ok) {
        return { ok: false, error: failureToError(hookResult) };
      }
    }

    return created;
  }

  /**
   * Run the `after_run` hook. Failures are logged and swallowed —
   * the worker's outcome (success / failure / cancellation) takes
   * precedence over a flaky cleanup hook.
   */
  async finalizeAfterRun(workspace: Workspace): Promise<void> {
    if (this.hooks.after_run === undefined) return;
    const result = await runHook({
      name: 'after_run',
      script: this.hooks.after_run,
      cwd: workspace.path,
      timeoutMs: this.hooks.timeout_ms,
    });
    if (!result.ok) {
      this.logger.warn('after_run hook failed (ignored per SPEC §9.4)', {
        workspace_path: workspace.path,
        error: result.error,
      });
    }
  }

  /**
   * Remove a workspace for a terminal issue. Runs `before_remove`
   * first (best effort), then `rm -rf`. Hook and removal failures
   * are both logged and ignored so the orchestrator's startup sweep
   * is not blocked by an unhealthy workspace.
   */
  async removeForTerminal(identifier: IssueIdentifier): Promise<void> {
    let path: string;
    try {
      path = workspacePathFor(this.root, identifier);
    } catch (cause) {
      // Containment failure during removal would mean someone tried
      // to remove a path outside the root — refuse loudly.
      this.logger.error('refused to remove workspace outside root', {
        identifier,
        cause,
      });
      return;
    }

    // If the workspace doesn't exist, we have nothing to do.
    let exists: boolean;
    try {
      await stat(path);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) return;

    if (this.hooks.before_remove !== undefined) {
      const result = await runHook({
        name: 'before_remove',
        script: this.hooks.before_remove,
        cwd: path,
        timeoutMs: this.hooks.timeout_ms,
      });
      if (!result.ok) {
        this.logger.warn('before_remove hook failed (cleanup proceeds)', {
          workspace_path: path,
          error: result.error,
        });
      }
    }

    try {
      await rm(path, { recursive: true, force: true });
    } catch (cause) {
      this.logger.error('workspace removal failed', {
        workspace_path: path,
        cause,
      });
    }
  }
}

// ---------------------------------------------------------------------
// Internals.

/**
 * Create the directory if missing, return whether we created it.
 *
 * Two-step strategy:
 *   1. mkdir(parent, recursive) — bring the parent up to existence.
 *      The workspace root is supposed to exist already; this handles
 *      a fresh first-run cleanly.
 *   2. mkdir(target) without `recursive` — atomic at the FS level.
 *      An EEXIST means another caller (or a previous run) created
 *      it; we then verify it's a directory.
 *
 * No TOCTOU: the EEXIST detection is intrinsic to the syscall.
 */
async function ensureDirectoryAtomic(
  path: string,
): Promise<
  | { ok: true; createdNow: boolean }
  | { ok: false; error: WorkspaceCreationError | WorkspaceNotADirectoryError }
> {
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true });
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'workspace_creation_failed',
        message: `Failed to ensure parent of '${path}': ${stringifyCause(cause)}`,
        path,
        cause,
      },
    };
  }

  try {
    await mkdir(path);
    return { ok: true, createdNow: true };
  } catch (cause) {
    const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null;
    if (code !== 'EEXIST') {
      return {
        ok: false,
        error: {
          code: 'workspace_creation_failed',
          message: `Failed to create '${path}': ${stringifyCause(cause)}`,
          path,
          cause,
        },
      };
    }
  }

  // EEXIST: confirm it's actually a directory and not a file someone
  // dropped at the workspace path.
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return {
        ok: false,
        error: {
          code: 'workspace_not_a_directory',
          message: `Path '${path}' exists but is not a directory.`,
          path,
        },
      };
    }
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'workspace_creation_failed',
        message: `EEXIST at '${path}' but stat() failed: ${stringifyCause(cause)}`,
        path,
        cause,
      },
    };
  }

  return { ok: true, createdNow: false };
}

/** Lift a hook failure result into the `WorkspaceError` union. */
function failureToError(failure: HookRunFailure): WorkspaceError {
  return failure.error;
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

export type { HookName };
