// zod schemas for `WORKFLOW.md` front matter.
//
// The schemas in this file are the canonical source of truth for the
// runtime config shape. Application code consumes the inferred types
// (`ServiceConfig`, etc.) — there is no parallel hand-written interface.
//
// Two structural choices are worth understanding:
//
//   1. The TOP-level object uses `.passthrough()` so unknown top-level keys
//      survive parsing untouched. This satisfies SPEC §5.3 ("Unknown keys
//      SHOULD be ignored for forward compatibility") and lets extensions
//      like `server: { port: ... }` (Plan 08) coexist without changing
//      the core schema.
//
//   2. Each known SECTION uses `.strict()` so a typo inside a section is
//      surfaced as a validation error. `tarcker.kind` would silently
//      succeed under passthrough; under strict it fails with a helpful
//      "unknown key" message that points at the typo.
//
// Path-shaped values flow through `.transform()` to apply `~` expansion,
// `$VAR` resolution, and absolutization against the workflow file's
// directory. This is why the schema is constructed by a factory function
// that takes the workflow file's `baseDir` — the base for relative paths
// must be the workflow file location, never `process.cwd()`.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveEnvVar, resolvePath } from './resolve.js';

/**
 * Helper: a zod transform that resolves a `$VAR` reference, leaving literals
 * alone. Used for `tracker.api_key` (and any future env-backed string fields
 * that are not paths).
 */
const envBackedString = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const resolved = resolveEnvVar(value);
    if (resolved === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Environment variable referenced in '${value}' is unset or empty.`,
      });
      return z.NEVER;
    }
    return resolved;
  });

/**
 * Build a service-config schema rooted at a specific workflow file directory.
 *
 * `baseDir` is the directory containing `WORKFLOW.md`. Relative path values
 * (notably `workspace.root`) resolve against this directory.
 */
export function buildServiceConfigSchema(baseDir: string) {
  // ---- tracker --------------------------------------------------------

  const TrackerConfigSchema = z
    .object({
      // `kind` is REQUIRED for dispatch (SPEC §5.3.1) but not for parse.
      // We accept any string here; the orchestrator's startup preflight
      // checks for a supported value before scheduling work.
      // Implementation values: 'linear' (Plan 06) and 'fake' (Plan 02 +
      // Plan 04 dev runs).
      kind: z.string().min(1).optional(),
      endpoint: z.string().url().default('https://api.linear.app/graphql'),
      api_key: envBackedString.optional(),
      project_slug: z.string().min(1).optional(),
      active_states: z.array(z.string().min(1)).default(['Todo', 'In Progress']),
      terminal_states: z
        .array(z.string().min(1))
        .default(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']),
      // Fake-tracker only: where to load initial issues from. Path is
      // resolved relative to the workflow file's directory.
      fixture_path: z
        .string()
        .min(1)
        .transform((value, ctx) => {
          const resolved = resolvePath(value, baseDir);
          if (resolved === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Environment variable referenced in tracker.fixture_path '${value}' is unset or empty.`,
            });
            return z.NEVER;
          }
          return resolved;
        })
        .optional(),
    })
    .strict()
    .default({});

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

  // ---- hooks ----------------------------------------------------------

  const HooksConfigSchema = z
    .object({
      after_create: z.string().optional(),
      before_run: z.string().optional(),
      after_run: z.string().optional(),
      before_remove: z.string().optional(),
      timeout_ms: z.number().int().positive().default(60_000),
    })
    .strict()
    .default({});

  // ---- agent ----------------------------------------------------------

  /**
   * Parse a record of `state -> positive integer`. Per SPEC §5.3.5, invalid
   * entries (non-positive or non-numeric) are silently dropped, NOT errors —
   * this lets operators add aspirational entries without breaking parse.
   * State keys are normalized to lowercase for lookup.
   */
  const MaxConcurrentByStateSchema = z
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
    });

  const ThinkingConfigSchema = z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('disabled'),
      })
      .strict(),
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

  // Per ADR 0008, the upstream spec's `codex.*` section is folded into
  // `agent.*` for this implementation. Generic timeout concepts (turn,
  // read, stall) belong on the agent regardless of backend; Codex-only
  // fields (`command`, `approval_policy`, `thread_sandbox`,
  // `turn_sandbox_policy`) are dropped — the Claude Agent SDK has no
  // equivalents. A WORKFLOW.md authored for upstream Symphony will
  // still parse here because top-level `.passthrough()` carries any
  // unknown `codex` section through unvalidated.
  const AgentConfigSchema = z
    .object({
      // Plan 07 — backend selector. The composition root branches on
      // this to pick between MockAgent (default for back-compat with
      // pre-Plan-07 workflows and CI fixtures) and ClaudeAgent. Like
      // `tracker.kind`, we accept any string here and let the
      // composition root reject unsupported values with a clear
      // startup error. We deliberately do NOT add an `agent.api_key`
      // field — the Claude Agent SDK reads `ANTHROPIC_API_KEY` from
      // `process.env` itself; the composition root verifies it is
      // present before instantiating ClaudeAgent.
      kind: z.string().min(1).optional(),
      // Plan 07 — model id for the `claude` backend. Default is the
      // low-cost Haiku 4.5 alias; override only when the user wants
      // a higher-capability model or a dated id. Ignored when
      // `kind` is anything other than `claude`.
      model: z.string().min(1).default('claude-haiku-4-5'),
      // Claude SDK thinking/reasoning behavior. Disabled by default
      // because this daemon's Linear workflow is mostly structured
      // tracker I/O, where extended thinking can dominate cost.
      thinking: ThinkingConfigSchema.default({ type: 'disabled' }),

      // Orchestrator-level concurrency and retry policy.
      max_concurrent_agents: z.number().int().positive().default(10),
      max_turns: z.number().int().positive().default(20),
      // Optional Claude SDK-specific cap. This is intentionally not
      // `max_turns`: Symphony turns are end-to-end agent calls; the
      // SDK's `maxTurns` bounds internal model round trips inside
      // one query call.
      max_model_round_trips: z.number().int().positive().optional(),
      // Optional per-query SDK budget guard. Undefined means "no
      // SDK budget cap"; live workflows can set this low while
      // smoke-testing against paid APIs.
      max_budget_usd: z.number().positive().optional(),
      max_retry_backoff_ms: z.number().int().positive().default(300_000),
      max_concurrent_agents_by_state: MaxConcurrentByStateSchema,

      // Per-turn agent runtime timeouts (lifted from spec's `codex.*`).
      // `stall_timeout_ms <= 0` is the documented "disable" signal —
      // see SPEC §5.3.6.
      turn_timeout_ms: z.number().int().positive().default(3_600_000),
      read_timeout_ms: z.number().int().positive().default(5_000),
      stall_timeout_ms: z.number().int().default(300_000),
    })
    .strict()
    .default({});

  // ---- top-level -----------------------------------------------------

  // Note: HTTP server settings (port, host) are deliberately NOT in
  // this schema. They are **deployment** concerns, configured via
  // env (`SYMPHONY_HTTP_PORT`, `SYMPHONY_HTTP_HOST`) so the same
  // WORKFLOW.md is portable across daemon instances. See the
  // composition root (`maybeStartHttpServer` in `index.ts`).

  return (
    z
      .object({
        tracker: TrackerConfigSchema,
        polling: PollingConfigSchema,
        workspace: WorkspaceConfigSchema,
        hooks: HooksConfigSchema,
        agent: AgentConfigSchema,
      })
      // Allow unknown top-level keys for forward compatibility with
      // future extensions and for compatibility with upstream-Symphony
      // WORKFLOW.md files that include `codex.*`. See header comment.
      .passthrough()
  );
}

// Inferred types. Application code imports these — never touches the schema
// directly except to call `buildServiceConfigSchema()` for parsing.

type ServiceConfigSchema = ReturnType<typeof buildServiceConfigSchema>;

export type ServiceConfig = z.infer<ServiceConfigSchema>;
export type TrackerConfig = ServiceConfig['tracker'];
export type PollingConfig = ServiceConfig['polling'];
export type WorkspaceConfig = ServiceConfig['workspace'];
export type HooksConfig = ServiceConfig['hooks'];
export type AgentConfig = ServiceConfig['agent'];
