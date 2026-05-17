// Plan 18a — build the `agents` config the Claude Agent SDK consumes.
//
// Each pipeline stage (sandbox, coder, ci) becomes a native SDK
// sub-agent with its own system prompt (its SKILL.md), its own
// scoped tool list, and is invoked by the parent agent via the
// built-in `Agent` tool.
//
// Tool scoping is principled per ADR 0014 / Plan 18a Decision 4:
// give each sub-agent only the tools it actually needs. Pre-18a,
// every tool was available to the single agent at all stages,
// which made it possible for @coder to accidentally hit Linear or
// for @ci to start editing files. Restricting per-sub-agent
// prevents those cross-stage mistakes mechanically.

import { dirname } from 'node:path';

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import type { SkillDefinition } from '../skills/index.js';

/**
 * Tool sets per sub-agent. Each list is the SDK tool-name set
 * passed to `AgentDefinition.tools`. Order is informational only;
 * the SDK treats them as an unordered allowlist.
 */
const SUB_AGENT_TOOLS = {
  sandbox: ['Bash', 'Read'] as const,
  planner: ['Bash', 'Read', 'Write', 'Glob', 'Grep'] as const,
  coder: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const,
  ci: ['Bash', 'Read'] as const,
} as const;

/**
 * Short, parent-facing descriptions of each sub-agent. The parent
 * agent's prompt instructs it on when/how to invoke each. These
 * descriptions are what the SDK surfaces if the parent uses the
 * `Agent` tool's discovery flow.
 */
const SUB_AGENT_DESCRIPTIONS = {
  sandbox:
    'Provisions a development environment for the current issue (clones the repo, starts services or microVM as needed) and returns a SandboxHandle JSON.',
  planner:
    'Reads the issue and decides whether it warrants a written execution plan. If yes, writes one to docs/exec-plans/active/ in the worktree. Returns a PlannerResult JSON with decision (planned|skipped), reason, and plan_path.',
  coder:
    'Reads the issue description and makes the requested code change inside the sandbox worktree. Returns a CoderResult JSON listing changed files plus a summary.',
  ci: 'Commits the changes the coder made, pushes the branch to origin, and opens (or reuses) a GitHub PR. Returns a CIResult JSON with the PR URL.',
} as const;

/**
 * Compose the per-sub-agent system prompt.
 *
 * The skill markdown is the body. Its references to `$SKILL_DIR`
 * are rewritten to the absolute path of the skill's directory on
 * disk *before* the SDK sees the prompt. We do this textually
 * (rather than passing `SKILL_DIR=<path>` as documentation and
 * hoping the sub-agent threads it through shell invocations)
 * because the SDK gives sub-agents a fresh shell on each `Bash`
 * call: there is no persistent env var. The first live smoke
 * (EDU-16, 2026-05-17) tripped on this — the sub-agent read
 * `SKILL_DIR=...` as text, then ran `bash "$SKILL_DIR/..."`,
 * which expanded to an empty string in its fresh shell. By
 * resolving the path here, the SKILL.md the sub-agent reads has
 * concrete absolute paths everywhere and no shell-variable
 * gymnastics are required.
 */
function buildSubAgentPrompt(skill: SkillDefinition): string {
  const skillDir = dirname(skill.path);
  // Replace `$SKILL_DIR` and `${SKILL_DIR}` (with or without braces,
  // case-insensitive) with the resolved absolute path.
  return skill.markdown.replace(/\$\{?SKILL_DIR\}?/gi, skillDir);
}

/**
 * Build the SDK `agents` config from the loaded skill definitions.
 * Caller passes the same `Map<string, SkillDefinition>` that the
 * pipeline runner already loads via `loadSkills(['sandbox','coder','ci'])`.
 *
 * If a required skill is missing from the map, its agent definition
 * still emits (with a placeholder prompt) so the SDK doesn't reject
 * the config; the runner detects the missing skill earlier and
 * fails the dispatch before we get this far.
 */
export function buildSubAgents(
  skills: Map<string, SkillDefinition>,
): Record<string, AgentDefinition> {
  const result: Record<string, AgentDefinition> = {};
  for (const name of ['sandbox', 'planner', 'coder', 'ci'] as const) {
    const skill = skills.get(name);
    const description = SUB_AGENT_DESCRIPTIONS[name];
    const tools = [...SUB_AGENT_TOOLS[name]];
    result[name] = {
      description,
      prompt:
        skill !== undefined
          ? buildSubAgentPrompt(skill)
          : `(skill '${name}' not found — pipeline runner should have failed earlier)`,
      tools,
    };
  }
  return result;
}

/**
 * Names this module knows how to build sub-agents for. Useful for
 * tests + the runner's REQUIRED_SKILLS list.
 */
export const SUB_AGENT_NAMES = ['sandbox', 'planner', 'coder', 'ci'] as const;
export type SubAgentName = (typeof SUB_AGENT_NAMES)[number];
