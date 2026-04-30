// zod schema for `<repo>/.symphony/workflow.md` — the per-repo,
// repo-team-owned workflow definition.
//
// ADR 0009 + ADR 0011: this file lives **inside the cloned repo** and
// is read by the **agent-runtime in the pod** after the clone. The
// daemon never reads it directly. We ship the schema in this package
// because:
//
//   - The pod runtime (Plan 10) imports it.
//   - A future "validate workflow.md before merging" CI step (Plan
//     11+) imports it.
//   - The daemon may use it for `--dry-run` validation of a
//     deployment YAML's referenced repos.
//
// Compared to the legacy WORKFLOW.md schema (`schema.ts`), this one
// drops every operator-deployment field:
//
//   - No `polling.*` (operator-side; daemon decides poll cadence).
//   - No `workspace.*` (operator-side; daemon decides where pods go).
//   - No `tracker.*` (operator-side; in `symphony.yaml` projects[]).
//   - No `agent.kind` (operator-side; in `symphony.yaml` agent.kind).
//   - No `agent.max_concurrent_*` (daemon-wide policy).
//   - No `agent.{turn,read,stall}_timeout_ms` (daemon-wide policy).
//
// What remains is the repo team's bailiwick:
//
//   - `agent.allowed_tools`: which SDK tools this repo permits the
//     agent to use. The pod forwards this list to the SDK as
//     `allowedTools`.
//   - `agent.model`: optional override of the operator's default
//     model.
//   - `agent.thinking`: optional override of the operator's default
//     thinking config.
//   - `agent.max_turns` / `agent.max_budget_usd`: optional repo-side
//     caps. The pod takes `min(operator_cap, repo_cap)` for budget
//     fields.
//   - `hooks.{after_create,before_run,after_run,before_remove}`:
//     repo-team-owned shell snippets. `before_run` is the typical
//     "install deps + checkout per-issue branch" body.
//   - The prompt template body itself (after the front matter).

import { z } from 'zod';

import type { WorkflowError, WorkflowLoadResult } from './errors.js';
import { parseWorkflow } from './parse.js';

/**
 * Build the per-repo workflow schema. No `baseDir` parameter: nothing
 * in this schema resolves filesystem paths, so the schema is pure
 * (constructable once at module load).
 */
export function buildRepoWorkflowSchema() {
  // ---- agent (per-repo overrides) ------------------------------------

  const ThinkingConfigSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('disabled') }).strict(),
    z
      .object({
        type: z.literal('adaptive'),
        display: z.enum(['summarized', 'omitted']).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('enabled'),
        budgetTokens: z.number().int().positive().optional(),
        display: z.enum(['summarized', 'omitted']).optional(),
      })
      .strict(),
  ]);

  const AgentOverridesSchema = z
    .object({
      // Repo-side overrides; all optional. Pod merges with the
      // operator-side defaults from the dispatch envelope.
      model: z.string().min(1).optional(),
      thinking: ThinkingConfigSchema.optional(),
      // Repo-team-owned tool allowlist. REQUIRED — there is no safe
      // default: the operator does not know what `allowed_tools`
      // makes sense for this repo. Default fallback when absent
      // from the file is the conservative built-in set returned by
      // `defaultRepoWorkflow()`.
      allowed_tools: z.array(z.string().min(1)).optional(),
      max_turns: z.number().int().positive().optional(),
      max_model_round_trips: z.number().int().positive().optional(),
      max_budget_usd: z.number().positive().optional(),
    })
    .strict()
    .default({});

  // ---- hooks (per-repo) ---------------------------------------------

  const RepoHooksSchema = z
    .object({
      after_create: z.string().optional(),
      before_run: z.string().optional(),
      after_run: z.string().optional(),
      before_remove: z.string().optional(),
    })
    .strict()
    .default({});

  // ---- top-level -----------------------------------------------------

  return z
    .object({
      agent: AgentOverridesSchema,
      hooks: RepoHooksSchema,
    })
    .passthrough();
}

type RepoWorkflowSchema = ReturnType<typeof buildRepoWorkflowSchema>;
export type RepoWorkflowConfig = z.infer<RepoWorkflowSchema>;
export type RepoAgentOverrides = RepoWorkflowConfig['agent'];
export type RepoHooks = RepoWorkflowConfig['hooks'];

/**
 * The full repo-workflow definition: front-matter config + the prompt
 * template body. The pod renders the template against the
 * freshly-fetched issue.
 */
export interface RepoWorkflowDefinition {
  readonly config: RepoWorkflowConfig;
  readonly promptTemplate: string;
}

/**
 * Conservative default for repos that have no `.symphony/workflow.md`
 * (or whose workflow file failed to load). The pod uses this as a
 * fallback. Behavior: post a "no workflow.md found" comment and exit
 * — does NOT make code changes. Repo teams opt in to the agent's
 * code-editing capability by writing a real workflow.md.
 *
 * The prompt template here is conservative on purpose: a missing
 * workflow.md is most likely a configuration mistake, and we don't
 * want the agent to start doing things by accident.
 */
/**
 * Parse a per-repo workflow.md from its raw contents. The pod calls
 * this after reading `<workspace>/<workflow_path>` from disk; the
 * daemon may call it via a `--dry-run` validator.
 *
 * `path` is used purely for error reporting. We reuse the existing
 * `WorkflowError` / `WorkflowLoadResult` shape so that downstream
 * formatters (`formatWorkflowError`) work unchanged on either kind
 * of workflow file.
 *
 * If the file has no front matter, the resulting config uses all
 * schema defaults — empty `agent` overrides, empty hooks. A
 * conservative caller might prefer `defaultRepoWorkflow()` instead;
 * the difference is that this function trusts the file's prompt
 * body even when the front matter is empty, while `defaultRepoWorkflow()`
 * substitutes a "no workflow.md found" stub.
 */
export function parseRepoWorkflow(
  content: string,
  path: string,
): WorkflowLoadResult<RepoWorkflowDefinition> {
  const parseResult = parseWorkflow(content, path);
  if (!parseResult.ok) return { ok: false, error: parseResult.error };

  const schema = buildRepoWorkflowSchema();
  const validation = schema.safeParse(parseResult.value.frontMatter);

  if (!validation.success) {
    const error: WorkflowError = {
      code: 'workflow_validation_error',
      path,
      message: '.symphony/workflow.md failed validation. See issues for details.',
      issues: validation.error.issues,
    };
    return { ok: false, error };
  }

  return {
    ok: true,
    value: {
      config: validation.data,
      promptTemplate: parseResult.value.promptTemplate,
    },
  };
}

export function defaultRepoWorkflow(): RepoWorkflowDefinition {
  return {
    config: {
      agent: {
        allowed_tools: ['mcp__linear__linear_graphql'],
      },
      hooks: {},
    },
    promptTemplate: [
      'You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.',
      '',
      'This repository does not have a `.symphony/workflow.md` file.',
      'Symphony cannot determine the repo-team-defined workflow for this',
      'project, so it is unsafe to make code changes.',
      '',
      'Action: post a comment on this issue stating that no workflow.md',
      'was found, then transition the issue to Done. Do not edit code.',
    ].join('\n'),
  };
}
