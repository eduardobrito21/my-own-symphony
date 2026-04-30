// zod schemas for `symphony.yaml` — the operator-side deployment config.
//
// ADR 0009 splits Symphony's config into two layers:
//
//   - `symphony.yaml` (THIS FILE) — operator-owned. One per Symphony
//     install. Lists which Linear projects to watch, where to put
//     workspaces, daemon-wide concurrency + budget caps, the
//     ExecutionBackend selector, and per-project repo coordinates
//     (URL, default branch, optional image override).
//
//   - `<repo>/.symphony/workflow.md` (`repo-workflow.ts`) — per-repo,
//     repo-team-owned. Holds the prompt template + per-repo agent
//     overrides (model, allowed_tools, before_run/after_run hooks).
//     Loaded by the agent-runtime in the pod after the clone (per
//     ADR 0011), NOT by the daemon. The deployment schema here only
//     declares WHERE to find it (`workflow_path`), not what's inside.
//
// Two structural choices mirror `schema.ts`:
//
//   1. Top-level `.passthrough()` so unknown top-level keys survive
//      parsing. Lets future extensions (e.g. an `observability:` block)
//      coexist without bumping this schema.
//
//   2. Each section uses `.strict()` so a typo inside a known section
//      surfaces as a validation error.
//
// Path-shaped values flow through `.transform()` to apply `~`/`$VAR`
// resolution and absolutization against `symphony.yaml`'s directory.
//
// What is NOT in this schema (intentionally):
//   - Tracker `api_key` / `endpoint` — those are *process* config,
//     not deployment config. The daemon reads `LINEAR_API_KEY` from
//     `process.env`. Per-project credential isolation is a later plan.
//   - Per-repo `agent.allowed_tools`, `agent.model`, hook bodies —
//     all in `<repo>/.symphony/workflow.md`. The pod reads them
//     after clone.
//   - Anything pod-runtime related — Plan 10.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { resolvePath } from './resolve.js';

/**
 * Build a deployment-config schema rooted at a specific directory.
 *
 * `baseDir` is the directory containing `symphony.yaml`. Relative path
 * values (notably `workspace.root`) resolve against this directory.
 */
export function buildDeploymentConfigSchema(baseDir: string) {
  // ---- polling --------------------------------------------------------

  const PollingConfigSchema = z
    .object({
      interval_ms: z.number().int().positive().default(30_000),
    })
    .strict()
    .default({});

  // ---- workspace ------------------------------------------------------

  const WorkspaceConfigSchema = z
    .object({
      root: z
        .string()
        .min(1)
        .default(join(tmpdir(), 'symphony_workspaces'))
        .transform((value, ctx) => {
          const resolved = resolvePath(value, baseDir);
          if (resolved === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Environment variable referenced in workspace.root '${value}' is unset or empty.`,
            });
            return z.NEVER;
          }
          return resolved;
        }),
    })
    .strict()
    .default({});

  // ---- agent (operator-side defaults) --------------------------------

  // The deployment-side agent block carries:
  //   - daemon-wide caps (max_concurrent_agents, retry backoff)
  //   - per-turn timeouts (turn / read / stall)
  //   - operator-side defaults that per-repo workflow.md may override
  //     (model, max_turns, max_budget_usd)
  //
  // Per-repo overrides go in `.symphony/workflow.md` (loaded by the
  // pod via `repo-workflow.ts`). The pod resolves effective settings:
  // repo-side wins for `model` / `allowed_tools`; budget caps take
  // `min(operator, repo)`.
  const AgentConfigSchema = z
    .object({
      kind: z.string().min(1).optional(),

      // Operator-side defaults (per-repo workflow may override).
      model: z.string().min(1).default('claude-haiku-4-5'),
      max_turns: z.number().int().positive().default(20),
      max_model_round_trips: z.number().int().positive().optional(),
      max_budget_usd: z.number().positive().optional(),

      // Daemon-wide settings (NOT overridable per-repo).
      max_concurrent_agents: z.number().int().positive().default(10),
      max_concurrent_agents_by_state: z
        .record(z.string(), z.unknown())
        .default({})
        .transform((raw) => {
          const result: Record<string, number> = {};
          for (const [stateName, value] of Object.entries(raw)) {
            if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
              result[stateName.toLowerCase()] = value;
            }
          }
          return result;
        }),
      max_retry_backoff_ms: z.number().int().positive().default(300_000),

      // Per-turn agent runtime timeouts. `stall_timeout_ms <= 0` is
      // the "disable" signal (SPEC §5.3.6).
      turn_timeout_ms: z.number().int().positive().default(3_600_000),
      read_timeout_ms: z.number().int().positive().default(5_000),
      stall_timeout_ms: z.number().int().default(300_000),
    })
    .strict()
    .default({});

  // ---- execution (NEW — Plan 09 / ADR 0011) --------------------------

  const ExecutionConfigSchema = z
    .object({
      // Where the agent process runs:
      //   - `local-docker` (default, Plan 10): per-issue Docker pods
      //     via `LocalDockerBackend`. Production target.
      //   - `in-process`: the daemon constructs `ClaudeAgent` and
      //     runs it in its own process — no docker needed. Useful
      //     for local development against a single repo without
      //     the image-build cycle. Inherits the daemon's
      //     filesystem + network; no isolation boundary.
      // Future: `e2b`, `ecs`, etc.
      backend: z.enum(['local-docker', 'in-process']).default('local-docker'),
      // The default agent image to use when a project does not
      // specify `agent_image` and does not ship a
      // `.symphony/agent.dockerfile` or `.devcontainer/Dockerfile`.
      // See Plan 10 step 7 for the full image-resolution order.
      // Ignored when `backend: in-process`.
      base_image: z.string().min(1).default('symphony/agent-base:1'),
    })
    .strict()
    .default({});

  // ---- hooks (deployment-wide hook timeout only) ---------------------

  // Per-repo workflows declare their own hook bodies (before_run,
  // after_run, etc.) in `.symphony/workflow.md`. The deployment-side
  // hooks block here only carries the daemon-wide timeout. We keep
  // the section so the structure parallels the legacy WORKFLOW.md
  // shape (eases the single-project compat synthesis).
  const HooksConfigSchema = z
    .object({
      timeout_ms: z.number().int().positive().default(60_000),
    })
    .strict()
    .default({});

  // ---- projects (NEW — multi-project per ADR 0009) -------------------

  const LinearTrackerSpecSchema = z
    .object({
      project_slug: z.string().min(1),
      // `active_states` and `terminal_states` are operator-side
      // policy (which states the daemon polls / treats as terminal).
      // Defaults match the legacy schema for back-compat.
      active_states: z.array(z.string().min(1)).default(['Todo', 'In Progress']),
      terminal_states: z
        .array(z.string().min(1))
        .default(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']),
    })
    .strict();

  const RepoSpecSchema = z
    .object({
      url: z.string().min(1),
      default_branch: z.string().min(1).default('main'),
      // Optional explicit image override (skips the resolution
      // order — the daemon errors if the tag is missing locally).
      agent_image: z.string().min(1).optional(),
      // Path inside the cloned repo to the per-repo workflow file.
      // Default matches the convention in ADR 0009.
      workflow_path: z.string().min(1).default('.symphony/workflow.md'),
      // Prefix for the per-issue branch name. Full branch will be
      // `<branch_prefix><issue_identifier>`. See Plan 11 for the
      // idempotent branch reuse semantics.
      branch_prefix: z.string().min(1).default('symphony/'),
    })
    .strict();

  const ProjectEntrySchema = z
    .object({
      // Tracker spec is a discriminated union for future tracker
      // types (GitHub Issues, Jira). Today only `linear` is
      // supported; the discriminator pattern is set up so adding
      // a tracker is one variant, not a schema rewrite.
      linear: LinearTrackerSpecSchema,
      repo: RepoSpecSchema,
    })
    .strict();

  // ---- top-level -----------------------------------------------------

  return z
    .object({
      polling: PollingConfigSchema,
      workspace: WorkspaceConfigSchema,
      agent: AgentConfigSchema,
      execution: ExecutionConfigSchema,
      hooks: HooksConfigSchema,
      projects: z
        .array(ProjectEntrySchema)
        .min(1, 'symphony.yaml must declare at least one project'),
    })
    .passthrough();
}

// Inferred types — application code imports these.

type DeploymentConfigSchema = ReturnType<typeof buildDeploymentConfigSchema>;

export type DeploymentConfig = z.infer<DeploymentConfigSchema>;
export type ProjectEntry = DeploymentConfig['projects'][number];
export type LinearTrackerSpec = ProjectEntry['linear'];
export type RepoSpec = ProjectEntry['repo'];
export type ExecutionConfig = DeploymentConfig['execution'];

/**
 * The deployment definition returned by the loader: the typed config
 * plus the file path it came from. Matches the shape of
 * `WorkflowDefinition` for symmetry with the legacy loader.
 */
export interface DeploymentDefinition {
  readonly config: DeploymentConfig;
  /** Absolute path to the symphony.yaml that produced this. */
  readonly path: string;
}
