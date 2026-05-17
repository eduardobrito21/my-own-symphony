// Typed errors raised by the workspace layer.
//
// Same discriminated-union pattern as `WorkflowError` and
// `TrackerError`: plain objects with a `code` field, surfaced as
// return values rather than thrown across the layer boundary so the
// orchestrator can handle them structurally.
//
// Hook-related error variants (HookTimeoutError, HookNonZeroExitError,
// HookSpawnError) were removed in Plan 15 when the hook system moved
// into the future @app skill. Filesystem failures remain.
//   - workspace creation failure -> retry next tick
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

export type WorkspaceError =
  | WorkspaceContainmentError
  | WorkspaceCreationError
  | WorkspaceNotADirectoryError;
