// `loadWorkflow(path)` — the end-to-end entry point for the config layer.
//
// Pipeline (matches SPEC §6.1):
//   1. Read the file. If missing, return `missing_workflow_file`.
//   2. Split YAML front matter from prompt body (`parse.ts`).
//   3. Validate + apply defaults via the zod schema (`schema.ts`),
//      with `baseDir` set to the directory containing the workflow file
//      so relative paths resolve correctly.
//   4. Return `{ config, promptTemplate, path }` or a typed error.
//
// Errors are returned, never thrown, so the orchestrator's startup preflight
// can convert them into structured operator output.

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePathSegments } from 'node:path';

import type { WorkflowError, WorkflowLoadResult } from './errors.js';
import { parseWorkflow } from './parse.js';
import { buildServiceConfigSchema, type WorkflowDefinition } from './schema.js';

/**
 * Read, parse, and validate a `WORKFLOW.md` file.
 *
 * `path` may be relative or absolute. We absolutize it before reading so that
 * the resulting `WorkflowDefinition.path` is stable regardless of where the
 * daemon is launched from.
 */
export async function loadWorkflow(path: string): Promise<WorkflowLoadResult<WorkflowDefinition>> {
  const absolutePath = resolvePathSegments(path);

  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (cause) {
    return {
      ok: false,
      error: missingFileError(absolutePath, cause),
    };
  }

  const parseResult = parseWorkflow(content, absolutePath);
  if (!parseResult.ok) {
    return { ok: false, error: parseResult.error };
  }

  const baseDir = dirname(absolutePath);
  const schema = buildServiceConfigSchema(baseDir);
  const validation = schema.safeParse(parseResult.value.frontMatter);

  if (!validation.success) {
    const error: WorkflowError = {
      code: 'workflow_validation_error',
      path: absolutePath,
      message: 'Workflow front matter failed validation. See issues for details.',
      issues: validation.error.issues,
    };
    return { ok: false, error };
  }

  const definition: WorkflowDefinition = {
    config: validation.data,
    promptTemplate: parseResult.value.promptTemplate,
    path: absolutePath,
  };

  return { ok: true, value: definition };
}

/**
 * Build a `missing_workflow_file` error from a filesystem read rejection.
 *
 * We distinguish ENOENT (the typical "file does not exist" case) from
 * other errors (permission denied, EISDIR, etc.) by checking the error
 * code. The orchestrator surfaces both as the same category — operators
 * fix them the same way (point at a real file) — but the message text
 * differs to avoid misleading them.
 */
function missingFileError(path: string, cause: unknown): WorkflowError {
  // `cause` arrives as `unknown` from `readFile`'s catch. After narrowing
  // with `'code' in cause`, TypeScript widens `cause.code` to `unknown` —
  // exactly the shape we want — so no further assertion is needed.
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null;
  const message =
    code === 'ENOENT'
      ? 'No file at this path. Create one or pass a different path.'
      : `Could not read file: ${stringifyCause(cause)}`;
  return { code: 'missing_workflow_file', path, message, cause };
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
