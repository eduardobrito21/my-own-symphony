// Strict prompt rendering for `WORKFLOW.md` templates.
//
// SPEC §5.4 / §12 require:
//   - Strict variable resolution: an unknown variable in the template
//     fails rendering rather than emitting an empty string.
//   - Strict filter resolution: an unknown filter (`{{ x | foo }}`)
//     fails rendering rather than passing through.
//
// We use `liquidjs` because it ships both modes as a single config
// flag, has stable semantics, and parses the spec's example template
// (`{{ issue.identifier }}`, `{{ issue.title }}`) without help.
//
// Rendering is intentionally async because liquidjs's `parseAndRender`
// is async (some filters do I/O). Our usage is always pure-data, but
// we don't fight the API.

import { Liquid, type Template } from 'liquidjs';

import type { Issue } from '../types/index.js';

/**
 * Engine instance reused across renders. Per liquidjs docs, the
 * engine is thread-safe (no shared mutable state) and intended to be
 * shared. Re-creating one per render would parse and discard parser
 * state on every call.
 *
 * `strictVariables` and `strictFilters` make missing identifiers fail
 * rendering rather than silently produce empty strings.
 */
const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  // Cache parsed templates by source string. Workflow body is fixed
  // until reload, so the same parse result is used per dispatch.
  cache: true,
});

/**
 * Inputs available to a workflow prompt template. SPEC §12.1.
 *
 * `attempt` is `null` on the first run and a positive integer on
 * retries / continuations. Templates can branch on it for retry-aware
 * instructions.
 */
export interface PromptContext {
  readonly issue: Issue;
  readonly attempt: number | null;
}

export interface PromptRenderOk {
  readonly ok: true;
  readonly value: string;
}

export interface PromptRenderError {
  readonly ok: false;
  readonly code: 'template_parse_error' | 'template_render_error';
  readonly message: string;
  readonly cause: unknown;
}

export type PromptRenderResult = PromptRenderOk | PromptRenderError;

/**
 * Pre-parse a template string. Parse errors surface here instead of at
 * render time, which lets the orchestrator distinguish "this template
 * is broken" from "this issue's data didn't match the template" when
 * choosing whether to retry.
 *
 * The returned `Template[]` is opaque — pass it to `renderPrompt`.
 */
export function parsePromptTemplate(
  source: string,
): { ok: true; template: Template[] } | { ok: false; error: PromptRenderError } {
  try {
    const template = engine.parse(source);
    return { ok: true, template };
  } catch (cause) {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'template_parse_error',
        message: stringifyCause(cause),
        cause,
      },
    };
  }
}

/**
 * Render a parsed template against an `Issue` + `attempt`. Returns the
 * rendered string or a typed error.
 *
 * Issue fields are exposed under `issue.*` with **snake_case** keys to
 * match what's in `WORKFLOW.md` examples upstream (e.g. SPEC §5.3
 * shows `{{ issue.identifier }}`). Internal types use camelCase, so
 * we adapt at this boundary.
 */
export async function renderPrompt(
  template: Template[],
  context: PromptContext,
): Promise<PromptRenderResult> {
  try {
    // liquidjs's `render` is typed `Promise<any>` because templates
    // can theoretically produce any value; in practice we always
    // emit text. We narrow to a string and coerce other shapes
    // defensively.
    const rendered: unknown = await engine.render(template, toLiquidContext(context));
    if (typeof rendered === 'string') {
      return { ok: true, value: rendered };
    }
    return { ok: true, value: String(rendered) };
  } catch (cause) {
    return {
      ok: false,
      code: 'template_render_error',
      message: stringifyCause(cause),
      cause,
    };
  }
}

/**
 * Convenience: parse + render in one call. For one-shot uses where
 * caching the parsed template doesn't matter.
 */
export async function parseAndRenderPrompt(
  source: string,
  context: PromptContext,
): Promise<PromptRenderResult> {
  const parsed = parsePromptTemplate(source);
  if (!parsed.ok) return parsed.error;
  return renderPrompt(parsed.template, context);
}

/**
 * Adapt our camelCase domain types to the snake_case keys the spec's
 * example templates use. `created_at` and `updated_at` are emitted as
 * ISO-8601 strings rather than `Date` objects so templates can use
 * them directly without filters.
 *
 * Note on nullable fields (`description`, `priority`, `branch_name`,
 * `url`, `created_at`, `updated_at`, every field on `blocked_by`):
 * we intentionally pass `null` through unchanged. Under
 * `strictVariables: true`, liquidjs renders a defined-but-null property
 * as the empty string (only *missing* keys throw). Template authors
 * can opt into explicit placeholders with `| default: "(unknown)"`.
 * See the "preserves null fields as empty strings" test in
 * `prompt.test.ts` for the contract.
 */
function toLiquidContext(context: PromptContext): Record<string, unknown> {
  const { issue, attempt } = context;
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branch_name: issue.branchName,
      url: issue.url,
      labels: issue.labels,
      blocked_by: issue.blockedBy.map((b) => ({
        id: b.id,
        identifier: b.identifier,
        state: b.state,
      })),
      created_at: issue.createdAt?.toISOString() ?? null,
      updated_at: issue.updatedAt?.toISOString() ?? null,
    },
    attempt,
  };
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
