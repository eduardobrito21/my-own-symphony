// Skill output schemas — zod-validated contracts between pipeline stages.
//
// Per ADR 0006: every boundary is parsed with zod. Skill outputs cross
// the boundary between the agent's execution and the orchestrator's
// state machine, so they get schemas.
//
// Per ADR 0014 / Plan 16: the `SandboxHandle` is the load-bearing
// contract between `@sandbox` and the downstream stages
// (`@planner`, `@coder`, `@curator`, `@ci`).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SandboxHandle — returned by @sandbox skill
// ---------------------------------------------------------------------------

/**
 * How downstream tools (e.g. @coder's Bash calls) reach into the sandbox.
 * Pattern A from ADR 0014: shell template with `{cmd}` placeholder.
 */
export const ExecConfigSchema = z.object({
  kind: z.literal('shell-template'),
  /**
   * Shell command template. `{cmd}` is replaced with the actual command.
   * Example: `docker compose -p {id} exec server {cmd}`
   */
  template: z.string().min(1),
});

export type ExecConfig = z.infer<typeof ExecConfigSchema>;

/**
 * How the sandbox gets cleaned up after the pipeline completes.
 */
export const TeardownConfigSchema = z.object({
  kind: z.enum(['deadline', 'script', 'both']),
  /** ISO 8601 timestamp after which the sandbox may be reaped. */
  expires_at: z.string().datetime().optional(),
  /** Shell command to run for explicit teardown. */
  script: z.string().optional(),
});

export type TeardownConfig = z.infer<typeof TeardownConfigSchema>;

/**
 * The structured output `@sandbox` returns. This is the load-bearing
 * contract between `@sandbox` and downstream stages.
 *
 * Fields:
 * - `id`: Platform-specific opaque identifier (compose project name, VM id).
 * - `kind`: Discriminator for downstream tooling.
 * - `worktree_path`: Absolute path where the agent reads/edits files.
 * - `exec`: How to run commands inside the sandbox.
 * - `teardown`: How/when to clean up.
 */
export const SandboxHandleSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1), // 'local-docker' | 'namespace-devbox' | ...
  worktree_path: z.string().min(1),
  exec: ExecConfigSchema,
  teardown: TeardownConfigSchema,
});

export type SandboxHandle = z.infer<typeof SandboxHandleSchema>;

// ---------------------------------------------------------------------------
// PlannerResult — returned by @planner skill (Plan 20)
// ---------------------------------------------------------------------------

/**
 * The structured output `@planner` returns. The planner reads the
 * issue and decides whether it warrants a written execution plan; if
 * yes, it writes one to `docs/exec-plans/active/<NN>-<slug>.md` in
 * the worktree and returns the relative path. If no, it returns
 * `decision: "skipped"` with a one-line reason.
 *
 * `plan_path` is non-null iff `decision === "planned"`. zod doesn't
 * encode that cross-field invariant directly here — we keep both
 * fields independent and let the consumer check.
 */
export const PlannerResultSchema = z.object({
  decision: z.enum(['planned', 'skipped']),
  reason: z.string().min(1),
  plan_path: z.string().min(1).nullable(),
});

export type PlannerResult = z.infer<typeof PlannerResultSchema>;

export function parsePlannerResult(input: unknown): PlannerResult {
  return PlannerResultSchema.parse(input);
}

export function safeParsePlannerResult(
  input: unknown,
): z.SafeParseReturnType<unknown, PlannerResult> {
  return PlannerResultSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// CoderResult — returned by @coder skill (stub in Plan 16, real in Plan 18)
// ---------------------------------------------------------------------------

/**
 * The structured output `@coder` returns. Plan 16 ships a stub that
 * returns an empty `changed_files` array. Plan 18 implements the real
 * coding agent.
 */
export const CoderResultSchema = z.object({
  /** Files modified by the coder (relative paths from worktree root). */
  changed_files: z.array(z.string()),
  /** Optional summary of what was done. */
  summary: z.string().optional(),
});

export type CoderResult = z.infer<typeof CoderResultSchema>;

// ---------------------------------------------------------------------------
// CuratorResult — returned by @curator skill (Plan 20)
// ---------------------------------------------------------------------------

/**
 * One flagged finding from the curator's audit. Surfaced to the
 * operator via the parent agent's Linear close-out comment.
 *
 * `line` is best-effort — the curator omits it when it can't pin a
 * specific line (e.g. a missing-cross-reference finding that spans
 * multiple occurrences).
 */
export const CuratorFlagSchema = z.object({
  rule: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  concern: z.string().min(1),
  suggested_fix: z.string().min(1),
});

export type CuratorFlag = z.infer<typeof CuratorFlagSchema>;

/**
 * Output of `@curator`'s per-pipeline audit. `auto_fixes` are
 * relative paths the curator already edited in the worktree (`@ci`
 * will commit them alongside the coder's changes). `flags` are
 * findings that need human judgement — the parent agent renders
 * them into the Linear close-out comment.
 *
 * `decision: "skipped"` means no rule triggered (e.g. the
 * changeset was pure code with no harness-relevant content).
 */
export const CuratorResultSchema = z.object({
  decision: z.enum(['audited', 'skipped']),
  summary: z.string().min(1),
  auto_fixes: z.array(z.string()),
  flags: z.array(CuratorFlagSchema),
});

export type CuratorResult = z.infer<typeof CuratorResultSchema>;

export function parseCuratorResult(input: unknown): CuratorResult {
  return CuratorResultSchema.parse(input);
}

export function safeParseCuratorResult(
  input: unknown,
): z.SafeParseReturnType<unknown, CuratorResult> {
  return CuratorResultSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate a SandboxHandle from unknown input. Throws a
 * ZodError if validation fails.
 */
export function parseSandboxHandle(input: unknown): SandboxHandle {
  return SandboxHandleSchema.parse(input);
}

/**
 * Safe parse that returns a result object instead of throwing.
 */
export function safeParseSandboxHandle(
  input: unknown,
): z.SafeParseReturnType<unknown, SandboxHandle> {
  return SandboxHandleSchema.safeParse(input);
}

/**
 * Parse and validate a CoderResult from unknown input.
 */
export function parseCoderResult(input: unknown): CoderResult {
  return CoderResultSchema.parse(input);
}

/**
 * Safe parse for CoderResult.
 */
export function safeParseCoderResult(input: unknown): z.SafeParseReturnType<unknown, CoderResult> {
  return CoderResultSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// CIResult — returned by @ci skill (MVP shipped alongside Plan 17a;
// Plan 19 will replace with the full version).
// ---------------------------------------------------------------------------

/**
 * The structured output `@ci` returns. The load-bearing fields are
 * `pr_url` (what the daemon posts back to Linear) and `pr_number`
 * (what future code may want for cross-referencing). Other fields are
 * informational for the audit trail.
 *
 * `reused: true` means @ci found an existing PR for the branch and
 * did not open a new one (re-dispatch idempotency).
 */
export const CIResultSchema = z.object({
  pr_url: z.string().url(),
  pr_number: z.number().int().positive(),
  branch: z.string().min(1),
  head_sha: z.string().min(1).optional(),
  reused: z.boolean().optional(),
});

export type CIResult = z.infer<typeof CIResultSchema>;

export function parseCIResult(input: unknown): CIResult {
  return CIResultSchema.parse(input);
}

export function safeParseCIResult(input: unknown): z.SafeParseReturnType<unknown, CIResult> {
  return CIResultSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// EnvUpResult / EnvDownResult — Plan 21 mechanical sensors
// ---------------------------------------------------------------------------

/**
 * Output of `@env-up` (and same shape for `@env-down`). Both
 * sensors invoke a target-repo-owned script read from
 * `<worktree>/.symphony/recipes.yaml`.
 *
 * `skipped: true` means the recipe key was missing — not an error,
 * just nothing to do. The pipeline continues; downstream sensors
 * that need a running env will fail predictably and the loop's
 * escalation handles them.
 *
 * On run: `succeeded` is the script's exit-0 status; `stderr_tail`
 * is the last ~50 lines of stderr captured for debugging (the
 * agent surfaces it on failure into the Linear comment).
 */
export const EnvUpResultSchema = z.object({
  skipped: z.boolean(),
  succeeded: z.boolean().optional(),
  stderr_tail: z.string().optional(),
  duration_seconds: z.number().optional(),
  reason: z.string().optional(),
});

export type EnvUpResult = z.infer<typeof EnvUpResultSchema>;

export function parseEnvUpResult(input: unknown): EnvUpResult {
  return EnvUpResultSchema.parse(input);
}

export function safeParseEnvUpResult(input: unknown): z.SafeParseReturnType<unknown, EnvUpResult> {
  return EnvUpResultSchema.safeParse(input);
}

// `@env-down` uses the identical shape. Aliased for clarity at
// call sites — the schema is the same.
export const EnvDownResultSchema = EnvUpResultSchema;
export type EnvDownResult = EnvUpResult;

// ---------------------------------------------------------------------------
// VerifyResult — Plan 21 mechanical sensor
// ---------------------------------------------------------------------------

/**
 * Output of `@verify`. Aggregates the target repo's typecheck +
 * lint + test commands (read from `.symphony/recipes.yaml`) into a
 * single pass/fail. Runs steps in order; stops on first failure.
 *
 * `passed === true` means every present recipe step succeeded.
 * Missing recipe keys are recorded in `skipped_steps` (not flagged
 * as failures — the operator opted out of that step for this repo).
 *
 * On failure: `failed_step` names which step bailed, and
 * `output_tail` carries the last ~100 lines of stderr+stdout so
 * the parent agent can pass it to the next `@coder` iteration.
 */
export const VerifyResultSchema = z.object({
  passed: z.boolean(),
  failed_step: z.enum(['typecheck', 'lint', 'test']).nullable(),
  output_tail: z.string().optional(),
  skipped_steps: z.array(z.enum(['typecheck', 'lint', 'test'])),
});

export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export function parseVerifyResult(input: unknown): VerifyResult {
  return VerifyResultSchema.parse(input);
}

export function safeParseVerifyResult(
  input: unknown,
): z.SafeParseReturnType<unknown, VerifyResult> {
  return VerifyResultSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// CodeReviewResult — Plan 21 judgement sensor
// ---------------------------------------------------------------------------

/**
 * One flagged finding from `@code-review`. Same general shape as
 * `CuratorFlag` (rule / file / line? / concern / suggested_fix)
 * but the rules describe different concerns: comment quality,
 * scar tissue, code smells, principle adherence against the
 * target repo's top-level concern docs (SECURITY.md, etc.).
 *
 * `suggested_fix` is a literal patch the next `@coder` iteration
 * applies — not free-form prose. E.g. "replace lines 42-44 of
 * foo.ts with: <three-line block>".
 */
export const CodeReviewFlagSchema = z.object({
  rule: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  concern: z.string().min(1),
  suggested_fix: z.string().min(1),
});

export type CodeReviewFlag = z.infer<typeof CodeReviewFlagSchema>;

/**
 * Output of `@code-review`. Propose-only — `@code-review` itself
 * never edits files; `flags` carry the patches that the next
 * `@coder` loop iteration applies.
 *
 * `decision: 'skipped'` means no changed files were
 * code-review-relevant (e.g., the changeset was a pure docs
 * commit or empty). `decision: 'audited'` means review ran;
 * `flags: []` is the clean case.
 */
export const CodeReviewResultSchema = z.object({
  decision: z.enum(['audited', 'skipped']),
  summary: z.string().min(1),
  flags: z.array(CodeReviewFlagSchema),
});

export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;

export function parseCodeReviewResult(input: unknown): CodeReviewResult {
  return CodeReviewResultSchema.parse(input);
}

export function safeParseCodeReviewResult(
  input: unknown,
): z.SafeParseReturnType<unknown, CodeReviewResult> {
  return CodeReviewResultSchema.safeParse(input);
}
