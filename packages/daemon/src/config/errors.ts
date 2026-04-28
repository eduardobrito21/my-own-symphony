// Typed errors raised by the workflow loader and config layer.
//
// We model errors as a discriminated union of plain objects (rather than a
// hierarchy of Error subclasses) for two reasons:
//
//   1. The orchestrator handles config errors via pattern matching on `.code`,
//      and TypeScript's narrowing on string-literal unions is more reliable
//      than `instanceof` checks (especially across module boundaries where
//      class identity can be fragile).
//
//   2. Carrying the cause and contextual fields as data rather than as a
//      thrown stack trace makes errors easier to surface to operators
//      structurally (logs, dashboard) without losing detail.
//
// Error category names match SPEC §5.5 verbatim where applicable so the
// behavior described in the spec maps 1:1 to a code we can match on.

import type { z } from 'zod';

export interface MissingWorkflowFile {
  readonly code: 'missing_workflow_file';
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}

export interface WorkflowParseError {
  readonly code: 'workflow_parse_error';
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}

export interface WorkflowFrontMatterNotMap {
  readonly code: 'workflow_front_matter_not_a_map';
  readonly path: string;
  readonly message: string;
  readonly actualType: string;
}

export interface WorkflowValidationError {
  readonly code: 'workflow_validation_error';
  readonly path: string;
  readonly message: string;
  readonly issues: readonly z.ZodIssue[];
}

export type WorkflowError =
  | MissingWorkflowFile
  | WorkflowParseError
  | WorkflowFrontMatterNotMap
  | WorkflowValidationError;

/**
 * Result type for `loadWorkflow`. Callers must check `ok` to discriminate.
 *
 * We avoid throwing across the loader boundary so the orchestrator's startup
 * preflight can convert config errors into operator-visible logs without
 * unwinding.
 */
export type WorkflowLoadResult<T> = { ok: true; value: T } | { ok: false; error: WorkflowError };

/**
 * Format a workflow error into a one-line string suitable for operator output.
 *
 * The message is intended to be enough on its own to take corrective action:
 * it tells the reader which file, what went wrong, and (when applicable) the
 * specific path inside the YAML where validation failed.
 */
export function formatWorkflowError(error: WorkflowError): string {
  switch (error.code) {
    case 'missing_workflow_file':
      return `[${error.code}] ${error.path}: ${error.message}`;
    case 'workflow_parse_error':
      return `[${error.code}] ${error.path}: ${error.message}`;
    case 'workflow_front_matter_not_a_map':
      return `[${error.code}] ${error.path}: ${error.message} (got ${error.actualType})`;
    case 'workflow_validation_error': {
      const issueLines = error.issues
        .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n');
      return `[${error.code}] ${error.path}: ${error.message}\n${issueLines}`;
    }
  }
}
