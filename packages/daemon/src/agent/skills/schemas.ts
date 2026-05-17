// Skill output schemas — zod-validated contracts between pipeline stages.
//
// Per ADR 0006: every boundary is parsed with zod. Skill outputs cross
// the boundary between the agent's execution and the orchestrator's
// state machine, so they get schemas.
//
// Per ADR 0014 / Plan 16: the `SandboxHandle` is the load-bearing
// contract between `@sandbox` and downstream stages (`@coder`, `@ci`).

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
