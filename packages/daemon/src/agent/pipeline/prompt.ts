// Pipeline orchestration prompt — the system prompt that drives the
// sub-agent pipeline.
//
// Per Plan 16 / ADR 0014, the parent agent runs in the daemon process
// and orchestrates a fixed pipeline. The shape evolves over time:
//
// - Plan 16 shipped @sandbox + stub @coder + hardcoded close-out.
// - Plan 17a made @sandbox a multi-backend dispatcher.
// - The MVP @coder + @ci shipped alongside Plan 17a (for the
//   end-to-end smoke) give us:
//      @sandbox → @coder → @ci? → close out
//   where @ci runs only when @coder reported changes. Plans 18 and 19
//   replace the MVP skills with the full versions.

import { dirname } from 'node:path';

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
 *   1. Execute @sandbox to provision a dev environment.
 *   2. Execute @coder to make code changes.
 *   3. If @coder produced changes, execute @ci to commit/push/PR.
 *      Skip otherwise.
 *   4. Close out: post a Linear comment summarizing the outcome and
 *      transition the issue to Done.
 */
export function buildPipelinePrompt(context: PipelinePromptContext): string {
  const { issue, repoUrl, branchPrefix, skills } = context;

  const sandboxSkill = skills.get('sandbox');
  const coderSkill = skills.get('coder');
  const ciSkill = skills.get('ci');

  const branchName = `${branchPrefix}${issue.identifier}`;

  const sections: string[] = [
    buildHeader(issue),
    buildPipelineOverview(),
    buildStage1SandboxSection(
      sandboxSkill,
      repoUrl,
      context.defaultBranch,
      branchName,
      issue.identifier,
      issue.labels,
    ),
    buildStage2CoderSection(coderSkill, issue),
    buildStage3CISection(ciSkill, issue, branchName, context.defaultBranch),
    buildStage4CloseOutSection(issue),
    buildOutputInstructions(),
  ];

  return sections.join('\n\n');
}

function buildHeader(issue: Issue): string {
  const labelLine = issue.labels.length === 0 ? '(none)' : issue.labels.join(', ');
  return `# Symphony Pipeline — Issue ${issue.identifier}

You are the Symphony orchestration agent. Your job is to execute a
pipeline of skills to address Linear issue **${issue.identifier}**: "${issue.title}".

Issue details:
- ID: ${issue.id}
- Identifier: ${issue.identifier}
- Title: ${issue.title}
- Description: ${issue.description ?? '(no description)'}
- State: ${issue.state}
- Labels: ${labelLine}
- URL: ${issue.url ?? '(no url)'}`;
}

function buildPipelineOverview(): string {
  return `## Pipeline Overview

Execute these stages in order:

1. **@sandbox** — Provision a development environment.
2. **@coder** — Read the description and make the code change.
3. **@ci** — Commit, push, open PR. **Skip this stage if @coder
   returned an empty \`changed_files\` list.**
4. **Close out** — Post a Linear comment summarizing the outcome
   (including the PR URL when one was opened), transition to Done.

Each stage produces a structured JSON output that feeds into the
next. Capture each output and pass it through.`;
}

function buildStage1SandboxSection(
  skill: SkillDefinition | undefined,
  repoUrl: string,
  defaultBranch: string,
  branchName: string,
  identifier: string,
  labels: readonly string[],
): string {
  const skillContent = skill?.markdown ?? '(skill not found)';
  const labelLine = labels.length === 0 ? '(none)' : labels.join(', ');
  // The @sandbox skill ships pre-set provisioning scripts alongside
  // SKILL.md (see packages/daemon/src/skills/sandbox/scripts/). The
  // agent invokes them by absolute path; we inject the directory here
  // so the skill markdown doesn't have to guess where it lives on disk.
  const skillDir = skill?.path !== undefined ? dirname(skill.path) : '(skill not found)';

  return `## Stage 1: @sandbox — Provision Development Environment

Execute the @sandbox skill to clone the repository and set up the
development environment.

**Inputs for @sandbox:**
- repo_url: ${repoUrl}
- default_branch: ${defaultBranch}
- branch: ${branchName}
- identifier: ${identifier}
- labels: ${labelLine}

The \`labels\` input drives @sandbox's backend selection. A
\`sandbox:<backend>\` label (e.g. \`sandbox:namespace\`) selects a
backend; with no such label, fall back to the operator default
(\`local\`).

The @sandbox skill lives on disk at:

    SKILL_DIR=${skillDir}

Its bundled provisioning scripts are at \`$SKILL_DIR/scripts/\`. The
skill instructs you to invoke them by absolute path (e.g.
\`bash "$SKILL_DIR/scripts/local-create.sh"\`).

<sandbox_skill>
${skillContent}
</sandbox_skill>

After executing @sandbox, you will have a \`SandboxHandle\` JSON object.
Validate that it has: id, kind, worktree_path, exec.template, teardown.

**REQUIRED before continuing to Stage 2**: emit the SandboxHandle
JSON verbatim in a fenced \`\`\`json code block in your assistant
text. The Symphony daemon scans for it; if it's missing the whole
run is marked failed. Do not skip this even if you have already
mentally validated the handle.`;
}

function buildStage2CoderSection(skill: SkillDefinition | undefined, issue: Issue): string {
  const skillContent = skill?.markdown ?? '(skill not found)';

  return `## Stage 2: @coder — Make the Code Change

Execute the @coder skill using the SandboxHandle from Stage 1.

**Inputs for @coder:**
- issue_identifier: ${issue.identifier}
- issue_title: ${issue.title}
- issue_description: ${issue.description ?? '(no description)'}
- sandbox_handle: (from Stage 1)

<coder_skill>
${skillContent}
</coder_skill>

After executing @coder, you will have a \`CoderResult\` JSON object
with a \`changed_files\` list and a \`summary\` string. **If
\`changed_files\` is empty, skip Stage 3 entirely and go directly to
Stage 4 close-out.**`;
}

function buildStage3CISection(
  skill: SkillDefinition | undefined,
  issue: Issue,
  branchName: string,
  defaultBranch: string,
): string {
  const skillContent = skill?.markdown ?? '(skill not found)';
  const skillDir = skill?.path !== undefined ? dirname(skill.path) : '(skill not found)';

  return `## Stage 3: @ci — Commit, Push, Open PR

**Skip this stage entirely** if Stage 2's \`CoderResult.changed_files\`
is empty. Go directly to Stage 4.

If there ARE changes, execute the @ci skill.

**Inputs for @ci:**
- worktree_path: (from sandbox_handle.worktree_path)
- branch: ${branchName}
- default_branch: ${defaultBranch}
- identifier: ${issue.identifier}
- issue_title: ${issue.title}
- issue_url: ${issue.url ?? ''}
- coder_summary: (from CoderResult.summary)

The @ci skill lives on disk at:

    SKILL_DIR=${skillDir}

Its bundled commit/push/PR script is at
\`$SKILL_DIR/scripts/ci-commit-push-pr.sh\`. Invoke it via Bash with
the env vars listed in the skill markdown.

<ci_skill>
${skillContent}
</ci_skill>

After executing @ci, you will have a \`CIResult\` JSON object with
\`pr_url\`, \`pr_number\`, \`branch\`, and \`head_sha\`. Keep the
\`pr_url\` — Stage 4 posts it back to Linear.`;
}

function buildStage4CloseOutSection(issue: Issue): string {
  return `## Stage 4: Close Out — Post Comment and Transition

Compose a Linear comment based on what happened in earlier stages:

- **If @ci ran and produced a PR**: comment body is
  \`Symphony opened PR: <pr_url>\` — substitute the actual URL from
  \`CIResult.pr_url\`. Include the marker
  \`<!-- symphony:completed issue=${issue.identifier} -->\` so
  re-dispatches can detect prior completion.
- **If @ci was skipped** (no changes from @coder): comment body is
  \`Symphony made no changes: <coder_summary>\` — substitute
  \`CoderResult.summary\`. Same marker.
- **If any stage failed**: comment body is
  \`Symphony pipeline failed at <stage>: <one-line reason>\`. Same
  marker.

1. **Post the comment**:
   - Use the \`linear_graphql\` tool.
   - Mutation: \`commentCreate(input: { issueId: "${issue.id}", body: "..." })\`.
   - Use the comment body composed above.

2. **Transition the issue to Done**:
   - Query the workflow states for the team:
     \`workflowStates(filter: { team: { issues: { id: { eq: "${issue.id}" } } } })\`
   - Find the state named \`Done\`.
   - Update: \`issueUpdate(id: "${issue.id}", input: { stateId: "<done_state_id>" })\``;
}

function buildOutputInstructions(): string {
  return `## Important Instructions

1. Execute stages **in order**. Stage 3 (@ci) is conditional on
   Stage 2 producing changes; everything else runs every dispatch.
2. Each skill produces a JSON output. Capture and use it for the
   next stage.
3. Use the \`Bash\` tool to run shell commands and invoke skill
   scripts.
4. Use the \`linear_graphql\` tool for Linear API calls (Stage 4).
5. If any stage fails, jump to Stage 4 with a failure summary —
   don't leave the issue silently stuck in In Progress.
6. The pipeline is complete when:
   - The Linear comment is posted.
   - The issue is transitioned to Done.`;
}
