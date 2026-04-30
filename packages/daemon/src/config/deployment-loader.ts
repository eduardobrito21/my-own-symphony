// `loadDeployment(path)` — entry point for the deployment-config layer.
//
// Pipeline (mirrors `loader.ts` for the legacy WORKFLOW.md):
//   1. Read the file. If missing, return `missing_workflow_file`.
//   2. Parse as plain YAML (no front-matter splitting — symphony.yaml
//      is pure YAML, no prompt body).
//   3. Validate + apply defaults via the zod schema, with `baseDir`
//      set to the directory containing symphony.yaml so relative
//      paths resolve correctly.
//   4. Return `{ config, path }` or a typed error.
//
// Errors are returned, never thrown — same contract as the legacy
// loader so the orchestrator's startup preflight can convert them
// into structured operator output.
//
// We deliberately reuse the existing `WorkflowError` union rather
// than creating a `DeploymentError` parallel hierarchy. The error
// codes (missing file, parse failure, validation failure) are the
// same set; the `path` field disambiguates which file. The legacy
// `formatWorkflowError` helper renders both kinds without changes.

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePathSegments } from 'node:path';

import { parse as parseYaml, YAMLError } from 'yaml';

import { buildDeploymentConfigSchema, type DeploymentDefinition } from './deployment.js';
import type { WorkflowError, WorkflowLoadResult } from './errors.js';

/**
 * Read, parse, and validate a `symphony.yaml` deployment config.
 *
 * `path` may be relative or absolute. Absolutized before reading so
 * the resulting `DeploymentDefinition.path` is stable regardless of
 * where the daemon is launched from.
 */
export async function loadDeployment(
  path: string,
): Promise<WorkflowLoadResult<DeploymentDefinition>> {
  const absolutePath = resolvePathSegments(path);

  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (cause) {
    return { ok: false, error: missingFileError(absolutePath, cause) };
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (cause) {
    const message = cause instanceof YAMLError ? cause.message : stringifyCause(cause);
    return {
      ok: false,
      error: {
        code: 'workflow_parse_error',
        path: absolutePath,
        message: `Failed to parse YAML: ${message}`,
        cause,
      },
    };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: 'workflow_front_matter_not_a_map',
        path: absolutePath,
        message: 'symphony.yaml must decode to a mapping at the root.',
        actualType: Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw,
      },
    };
  }

  const baseDir = dirname(absolutePath);
  const schema = buildDeploymentConfigSchema(baseDir);
  const validation = schema.safeParse(raw);

  if (!validation.success) {
    const error: WorkflowError = {
      code: 'workflow_validation_error',
      path: absolutePath,
      message: 'symphony.yaml failed validation. See issues for details.',
      issues: validation.error.issues,
    };
    return { ok: false, error };
  }

  return {
    ok: true,
    value: { config: validation.data, path: absolutePath },
  };
}

function missingFileError(path: string, cause: unknown): WorkflowError {
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null;
  const message =
    code === 'ENOENT'
      ? 'No symphony.yaml at this path. Create one or set $SYMPHONY_CONFIG.'
      : `Could not read file: ${stringifyCause(cause)}`;
  return { code: 'missing_workflow_file', path, message, cause };
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
