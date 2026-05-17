// Pipeline orchestration prompt — the system prompt that drives the
// sub-agent pipeline.
//
// Per Plan 16 / ADR 0014, the parent agent runs in the daemon process
// and orchestrates a fixed pipeline: @sandbox → @coder → close out.
// This module builds the orchestration prompt that includes the skill
// markdowns.

import type { Issue } from '../../types/index.js';
import type { SkillDefinition } from '../skills/index.js';

/**
 * Context for rendering the orchestration prompt.
 */
export interface PipelinePromptContext {
  readonly issue: Issue;
  readonly repoUrl: string;
  readonly defaultBranch: string;
  readonly branchPrefix: string;
  readonly skills: Map<string, SkillDefinition>;
}

/**
 * Build the orchestration prompt that drives the sub-agent pipeline.
 *
 * The prompt instructs the agent to:
 * 1. Execute @sandbox to provision a dev environment
 * 2. Execute @coder to make code changes (stub in Plan 16)
 * 3. Post a Linear comment confirming completion
 * 4. Transition the issue to Done
 */
export function buildPipelinePrompt(context: PipelinePromptContext): string {
  const { issue, repoUrl, branchPrefix, skills } = context;

  const sandboxSkill = skills.get('sandbox');
  const coderSkill = skills.get('coder');

  const branchName = `${branchPrefix}${issue.identifier}`;

  const sections: string[] = [
    buildHeader(issue),
    buildPipelineOverview(),
    buildStage1SandboxSection(sandboxSkill, repoUrl, branchName, issue.identifier),
    buildStage2CoderSection(coderSkill, issue),
    buildStage3CloseOutSection(issue),
    buildOutputInstructions(),
  ];

  return sections.join('\n\n');
}

function buildHeader(issue: Issue): string {
  return `# Symphony Pipeline — Issue ${issue.identifier}

You are the Symphony orchestration agent. Your job is to execute a
pipeline of skills to address Linear issue **${issue.identifier}**: "${issue.title}".

Issue details:
- ID: ${issue.id}
- Identifier: ${issue.identifier}
- Title: ${issue.title}
- Description: ${issue.description ?? '(no description)'}
- State: ${issue.state}`;
}

function buildPipelineOverview(): string {
  return `## Pipeline Overview

Execute these stages in order:

1. **@sandbox** — Provision a development environment
2. **@coder** — Make code changes (stub in Plan 16)
3. **Close out** — Post Linear comment, transition to Done

Each stage produces a structured JSON output that feeds into the next.`;
}

function buildStage1SandboxSection(
  skill: SkillDefinition | undefined,
  repoUrl: string,
  branchName: string,
  identifier: string,
): string {
  const skillContent = skill?.markdown ?? '(skill not found)';

  return `## Stage 1: @sandbox — Provision Development Environment

Execute the @sandbox skill to clone the repository and set up the
development environment.

**Inputs for @sandbox:**
- repo_url: ${repoUrl}
- branch: ${branchName}
- identifier: ${identifier}

<sandbox_skill>
${skillContent}
</sandbox_skill>

After executing @sandbox, you will have a \`SandboxHandle\` JSON object.
Validate that it has: id, kind, worktree_path, exec.template, teardown.`;
}

function buildStage2CoderSection(skill: SkillDefinition | undefined, issue: Issue): string {
  const skillContent = skill?.markdown ?? '(skill not found)';

  return `## Stage 2: @coder — Make Code Changes

Execute the @coder skill using the SandboxHandle from Stage 1.

**Inputs for @coder:**
- issue_title: ${issue.title}
- issue_identifier: ${issue.identifier}
- sandbox_handle: (from Stage 1)

<coder_skill>
${skillContent}
</coder_skill>

After executing @coder, you will have a \`CoderResult\` JSON object.`;
}

function buildStage3CloseOutSection(issue: Issue): string {
  return `## Stage 3: Close Out — Post Comment and Transition

After completing the pipeline:

1. **Post a Linear comment** on issue ${issue.identifier}:
   - Use the \`linear_graphql\` tool
   - Mutation: \`commentCreate(input: { issueId: "${issue.id}", body: "..." })\`
   - Comment body: "hello from symphony (pipeline) — Issue ${issue.identifier} processed."

2. **Transition the issue to Done**:
   - First, query the workflow states for the team:
     \`workflowStates(filter: { team: { issues: { id: { eq: "${issue.id}" } } } })\`
   - Find the state named "Done"
   - Update the issue: \`issueUpdate(id: "${issue.id}", input: { stateId: "<done_state_id>" })\``;
}

function buildOutputInstructions(): string {
  return `## Important Instructions

1. Execute stages **in order**. Do not skip stages.
2. Each skill produces a JSON output. Capture and use it for the next stage.
3. Use the \`Bash\` tool to run shell commands.
4. Use the \`linear_graphql\` tool for Linear API calls.
5. If any stage fails, report the error and stop the pipeline.
6. The pipeline is complete when:
   - The Linear comment is posted
   - The issue is transitioned to Done`;
}
