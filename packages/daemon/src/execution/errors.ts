// Typed errors raised by the execution layer.
//
// Same discriminated-union pattern as `WorkspaceError` and
// `TrackerError`: plain objects with a `code` field, surfaced via
// `ExecutionResult<T>` rather than thrown across the layer
// boundary so the orchestrator can branch on them structurally.
//
// Error codes carry distinct semantics for the orchestrator's
// retry policy:
//   - image_not_found      -> hard fail this turn; operator action
//                             needed (run `pnpm docker:build:<key>`)
//   - image_build_failed   -> hard fail; surface build output
//   - pod_start_failed     -> retry next tick; transient (e.g.
//                             docker daemon restart)
//   - pod_not_found        -> usually expected (idempotent stop on
//                             already-cleaned pod); never fatal
//   - pod_stop_failed      -> log + ignore; cleanup is best-effort
//   - event_stream_closed  -> orchestrator interprets as the agent
//                             pod exited; check logsTail() for cause

export interface ImageNotFoundError {
  readonly code: 'image_not_found';
  readonly message: string;
  readonly tag: string;
}

export interface ImageBuildFailedError {
  readonly code: 'image_build_failed';
  readonly message: string;
  readonly tag: string;
  readonly stderrTail: string;
}

export interface PodStartFailedError {
  readonly code: 'pod_start_failed';
  readonly message: string;
  readonly podName: string;
  readonly cause: unknown;
}

export interface PodNotFoundError {
  readonly code: 'pod_not_found';
  readonly message: string;
  readonly podName: string;
}

export interface PodStopFailedError {
  readonly code: 'pod_stop_failed';
  readonly message: string;
  readonly podName: string;
  readonly cause: unknown;
}

export interface EventStreamClosedError {
  readonly code: 'event_stream_closed';
  readonly message: string;
  readonly podName: string;
}

export type ExecutionError =
  | ImageNotFoundError
  | ImageBuildFailedError
  | PodStartFailedError
  | PodNotFoundError
  | PodStopFailedError
  | EventStreamClosedError;

export type ExecutionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExecutionError };
