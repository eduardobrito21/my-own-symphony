// Typed errors raised by the workspace layer.
//
// Same discriminated-union pattern as `WorkflowError` and
// `TrackerError`: plain objects with a `code` field, surfaced as
// return values rather than thrown across the layer boundary so the
// orchestrator can handle them structurally.
//
// Filesystem and hook failures get distinct codes because the
// orchestrator's response differs:
//   - workspace creation failure -> retry next tick
//   - hook timeout -> kill child, retry with backoff
//   - path containment violation -> never retry, fail loudly (this
//     would indicate a bug in our sanitization logic)

export interface WorkspaceContainmentError {
  readonly code: 'workspace_containment';
  readonly message: string;
  readonly root: string;
  readonly candidate: string;
}

export interface WorkspaceCreationError {
  readonly code: 'workspace_creation_failed';
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkspaceNotADirectoryError {
  readonly code: 'workspace_not_a_directory';
  readonly message: string;
  readonly path: string;
}

export interface HookTimeoutError {
  readonly code: 'hook_timeout';
  readonly message: string;
  readonly hook: string;
  readonly timeoutMs: number;
}

export interface HookNonZeroExitError {
  readonly code: 'hook_non_zero_exit';
  readonly message: string;
  readonly hook: string;
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface HookSpawnError {
  readonly code: 'hook_spawn_failed';
  readonly message: string;
  readonly hook: string;
  readonly cause: unknown;
}

export type WorkspaceError =
  | WorkspaceContainmentError
  | WorkspaceCreationError
  | WorkspaceNotADirectoryError
  | HookTimeoutError
  | HookNonZeroExitError
  | HookSpawnError;
