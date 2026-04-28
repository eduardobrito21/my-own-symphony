// Splitter for `WORKFLOW.md`: separates YAML front matter from the prompt body.
//
// The format (per SPEC §5.2):
//
//   ---
//   <YAML>
//   ---
//   <Markdown body>
//
// Rules:
//   - Front matter is OPTIONAL. If the file does not start with `---`, the
//     entire file is the body and the config map is empty.
//   - The body is trimmed before being returned (leading/trailing whitespace
//     in the prompt template is never significant).
//   - YAML must decode to a map/object at the root. Lists or scalars are
//     errors (SPEC §5.2 last bullet).
//   - "Starts with `---`" means the very first line is exactly `---`. A `---`
//     anywhere else does not open a front matter block.

import { parse as parseYaml, YAMLError } from 'yaml';

import type { WorkflowError } from './errors.js';

export interface ParsedWorkflow {
  /** Raw YAML front matter as an unvalidated object. */
  readonly frontMatter: Record<string, unknown>;
  /** Trimmed prompt body. */
  readonly promptTemplate: string;
}

export type ParseResult = { ok: true; value: ParsedWorkflow } | { ok: false; error: WorkflowError };

/**
 * Marker line for the start and end of a YAML front matter block. We compare
 * against the trimmed line so trailing whitespace from editors is tolerated.
 */
const MARKER = '---';

/**
 * Parse the contents of a workflow file into a front-matter map and a body.
 *
 * `path` is used purely for error reporting; it does not influence parsing.
 * The reading of the file itself happens in `loader.ts`.
 */
export function parseWorkflow(content: string, path: string): ParseResult {
  const lines = content.split('\n');
  const firstLine = lines[0];

  // No front matter: the whole file is the prompt body.
  // (`undefined?.trim()` is `undefined`, which is not `MARKER`, so the
  // branch correctly fires for both empty files and files starting with
  // anything other than `---`.)
  if (firstLine?.trim() !== MARKER) {
    return {
      ok: true,
      value: {
        frontMatter: {},
        promptTemplate: content.trim(),
      },
    };
  }

  // Find the closing `---`. Search starts at line index 1 (skip the opener).
  // Note: an unterminated block is a parse error, not a "treat as body" case,
  // because the operator clearly intended to write front matter.
  let closingLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === MARKER) {
      closingLine = i;
      break;
    }
  }

  if (closingLine === -1) {
    return {
      ok: false,
      error: {
        code: 'workflow_parse_error',
        path,
        message:
          'Workflow file starts with `---` but no closing `---` was found. Either remove the opening marker or add a matching one.',
        cause: null,
      },
    };
  }

  const yamlText = lines.slice(1, closingLine).join('\n');
  const bodyText = lines
    .slice(closingLine + 1)
    .join('\n')
    .trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText, { strict: true });
  } catch (cause) {
    const message =
      cause instanceof YAMLError ? `YAML parse error: ${cause.message}` : 'YAML parse error.';
    return {
      ok: false,
      error: {
        code: 'workflow_parse_error',
        path,
        message,
        cause,
      },
    };
  }

  // SPEC §5.2: empty front matter (`---\n---`) is allowed; treat as empty map.
  if (parsed === null || parsed === undefined) {
    return {
      ok: true,
      value: {
        frontMatter: {},
        promptTemplate: bodyText,
      },
    };
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: 'workflow_front_matter_not_a_map',
        path,
        message: 'Workflow front matter must be a YAML map (key/value pairs at the top level).',
        actualType: Array.isArray(parsed) ? 'array' : typeof parsed,
      },
    };
  }

  return {
    ok: true,
    value: {
      frontMatter: parsed as Record<string, unknown>,
      promptTemplate: bodyText,
    },
  };
}
