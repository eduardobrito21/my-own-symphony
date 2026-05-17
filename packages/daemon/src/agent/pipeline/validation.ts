// Post-hoc validation of skill outputs the parent agent prints to text.
//
// Per ADR 0014 Decision 4 / Plan 16: skill outputs cross the boundary
// between agent execution and the orchestrator's state machine, so
// they get zod-validated at the boundary. Today the parent agent
// emits its `@sandbox` output as a fenced ```json block inside an
// assistant text message — there is no structured tool the agent
// must call to "finalize" the handle. So we scan the accumulated
// text after the run for fenced JSON blocks and pick the last one
// that satisfies `SandboxHandleSchema`.
//
// A future iteration may replace this with a typed `finalize_sandbox`
// SDK tool the agent has to call; that would give us validation at
// the time of emission instead of post-hoc. For now we keep changes
// small and validate from text.

import { SandboxHandleSchema, type SandboxHandle } from '../skills/schemas.js';

/**
 * Result of attempting to find a valid SandboxHandle in agent output.
 */
export type SandboxHandleSearchResult =
  | { readonly found: true; readonly handle: SandboxHandle; readonly raw: string }
  | { readonly found: false; readonly reason: string };

/**
 * Extract every ```json fenced code block from a body of text. The
 * matching is intentionally lenient: any fence whose info string
 * starts with `json` (case-insensitive) qualifies. Returns the raw
 * inner contents in order of appearance.
 */
export function extractFencedJsonBlocks(text: string): readonly string[] {
  const blocks: string[] = [];
  // Match ```json ... ``` non-greedy, capturing the body. `[\s\S]` so
  // newlines are included. We tolerate optional whitespace after the
  // info string and require the closing fence on its own line-ish.
  const fence = /```[ \t]*json\b[^\n]*\n([\s\S]*?)\n[ \t]*```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

/**
 * Search agent-emitted text for the last fenced JSON block that
 * validates as a `SandboxHandle`. The LAST matching block wins
 * because the agent's prompt instructs it to emit the handle as the
 * final output of stage 1; if it printed example handles earlier in
 * thinking-out-loud, we want the authoritative one.
 *
 * Returns a `{ found: false, reason }` if there were no fences, no
 * parseable JSON, or no JSON that satisfied the schema. The reason
 * is suitable for surfacing in a `turn_failed.reason` to the operator.
 */
export function findSandboxHandleInText(text: string): SandboxHandleSearchResult {
  const blocks = extractFencedJsonBlocks(text);
  if (blocks.length === 0) {
    return {
      found: false,
      reason:
        'No ```json code block found in agent output (expected @sandbox to emit a SandboxHandle)',
    };
  }

  // Walk blocks in reverse so the last one mentioned wins on tie.
  // Collect schema errors for the operator if nothing validates.
  const errors: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const raw = blocks[i];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      errors.push(`block ${String(i)}: invalid JSON (${stringifyCause(cause)})`);
      continue;
    }
    const result = SandboxHandleSchema.safeParse(parsed);
    if (result.success) {
      return { found: true, handle: result.data, raw };
    }
    errors.push(`block ${String(i)}: ${formatZodIssues(result.error.issues)}`);
  }

  return {
    found: false,
    reason: `No SandboxHandle-shaped JSON block in agent output. Tried ${String(blocks.length)} block(s): ${errors.join('; ')}`,
  };
}

function formatZodIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
): string {
  return issues
    .map((i) => {
      const path = i.path.length === 0 ? '(root)' : i.path.join('.');
      return `${path}: ${i.message}`;
    })
    .join(', ');
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
