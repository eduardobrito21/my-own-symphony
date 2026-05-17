// `WorkspaceManager` — the layer's public surface.
//
// Composes `paths.ts` and a few `node:fs/promises` primitives into the
// lifecycle the orchestrator wants:
//
//   prepareForRun(identifier)
//     -> createForIssue (mkdir)
//     -> Workspace
//
//   finalizeAfterRun(workspace)
//     -> no-op
//
//   removeForTerminal(identifier)
//     -> rm -rf
//
// Per Plan 15, the hook subsystem (after_create / before_run /
// after_run / before_remove) is removed. Per-repo lifecycle steps
// move into the future @app skill (Plan 16). The method names are
// preserved so the orchestrator's callers don't churn.
//
// Per-issue concurrency: the orchestrator's own claim system prevents
// two workers running on the same issue at once, but tests and
// pathological cases could double-call `createForIssue`. We use
// non-recursive `mkdir` to make creation atomic at the FS layer and
// detect the EEXIST race cleanly.

import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  sanitizeIdentifier,
  type IssueIdentifier,
  type ProjectKey,
  type Workspace,
} from '../types/index.js';

import type {
  WorkspaceCreationError,
  WorkspaceError,
  WorkspaceNotADirectoryError,
} from './errors.js';
import { WorkspaceContainmentException, workspacePathFor } from './paths.js';

export type CreateResult =
  | { readonly ok: true; readonly workspace: Workspace }
  | { readonly ok: false; readonly error: WorkspaceError };

export type PrepareResult = CreateResult;

export interface WorkspaceManagerArgs {
  /** Absolute path to `workspace.root`. */
  readonly root: string;
  /**
   * Optional logger for filesystem cleanup failures. Defaults to a
   * no-op so tests don't have to inject one.
   */
  readonly logger?: WorkspaceLogger;
}

export interface WorkspaceLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: WorkspaceLogger = {
  warn() {
    /* intentionally empty */
  },
  error() {
    /* intentionally empty */
  },
};

export class WorkspaceManager {
  private readonly root: string;
  private readonly logger: WorkspaceLogger;

  constructor(args: WorkspaceManagerArgs) {
    this.root = args.root;
    this.logger = args.logger ?? NOOP_LOGGER;
  }

  /**
   * Compute the workspace path without touching the filesystem.
   * Useful for the agent runner's pre-launch `cwd === workspacePath`
   * sanity check (SPEC §15.2 invariant 1).
   *
   * Multi-project (Plan 09): pass the issue's `projectKey` to
   * namespace the path. Pass `null` (or omit) for legacy
   * single-project layout (back-compat).
   */
  pathFor(identifier: IssueIdentifier, projectKey: ProjectKey | null = null): string {
    return workspacePathFor(this.root, identifier, projectKey);
  }

  /**
   * Ensure the per-issue workspace directory exists. Reusing an
   * existing workspace is the common case (workspaces are preserved
   * across runs per SPEC §9.1).
   */
  async createForIssue(
    identifier: IssueIdentifier,
    projectKey: ProjectKey | null = null,
  ): Promise<CreateResult> {
    let path: string;
    try {
      path = workspacePathFor(this.root, identifier, projectKey);
    } catch (cause) {
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

    return { ok: true, workspace };
  }

  /**
   * Pre-run lifecycle: create (or reuse) the workspace. Kept as a
   * named method so callers don't churn after the hook removal in
   * Plan 15 — it's now equivalent to `createForIssue`.
   */
  async prepareForRun(
    identifier: IssueIdentifier,
    projectKey: ProjectKey | null = null,
  ): Promise<PrepareResult> {
    return this.createForIssue(identifier, projectKey);
  }

  /**
   * Kept as a no-op so the orchestrator's call sites compile until
   * Plan 16 reshapes them. Previously ran the `after_run` hook.
   */
  async finalizeAfterRun(_workspace: Workspace): Promise<void> {
    /* no-op post Plan 15 */
  }

  /**
   * Remove a workspace for a terminal issue. Previously ran the
   * `before_remove` hook first; Plan 15 dropped that. Removal
   * failures are logged and ignored so the orchestrator's startup
   * sweep is not blocked by an unhealthy workspace.
   */
  async removeForTerminal(
    identifier: IssueIdentifier,
    projectKey: ProjectKey | null = null,
  ): Promise<void> {
    let path: string;
    try {
      path = workspacePathFor(this.root, identifier, projectKey);
    } catch (cause) {
      this.logger.error('refused to remove workspace outside root', {
        identifier,
        cause,
      });
      return;
    }

    let exists: boolean;
    try {
      await stat(path);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) return;

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

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
