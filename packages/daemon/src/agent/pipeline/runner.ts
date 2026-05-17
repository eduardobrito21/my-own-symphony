// `PipelineAgentRunner` — orchestrates the sub-agent pipeline.
//
// Per Plan 16 / ADR 0014, this runner replaces the NoopAgentRunner.
// It loads skills, builds the orchestration prompt, and runs the
// Claude SDK in the daemon process.
//
// The pipeline shape is fixed in v1: @sandbox → @planner → @coder →
// @curator → @ci → close out. @curator and @ci are conditional —
// both skip when @coder produced an empty `changed_files`. The
// runner loads skills from the repo (if available) or falls back to
// bundled defaults.

import type { Logger } from '../../observability/index.js';
import type { LinearClient } from '../../tracker/linear/client.js';
import type { Issue, IssueId, ProjectKey } from '../../types/index.js';
import type { AgentEvent, AgentRunInput, AgentRunner } from '../runner.js';
import { ClaudeAgent, type ClaudeAgentArgs, type QueryFn } from '../claude/agent.js';
import { loadSkills, SkillNotFoundError, type SkillDefinition } from '../skills/index.js';
import { buildParentPrompt } from './parent-prompt.js';
import { buildSubAgents, SUB_AGENT_NAMES } from './sub-agents.js';
import { findSandboxHandleInText } from './validation.js';

/**
 * Per-project dispatch info needed to build the pipeline prompt.
 * Passed from the composition root.
 */
export interface ProjectDispatchInfo {
  readonly repoUrl: string;
  readonly defaultBranch: string;
  readonly branchPrefix: string;
}

/**
 * Arguments for constructing PipelineAgentRunner.
 */
export interface PipelineAgentRunnerArgs {
  readonly linearClient: LinearClient;
  readonly logger: Logger;
  /** Per-project dispatch info (keyed by project key). */
  readonly projectDispatch: ReadonlyMap<ProjectKey, ProjectDispatchInfo>;
  /** Override the default model. */
  readonly model?: string;
  /** Maximum model round trips for one query. */
  readonly maxModelRoundTrips?: number;
  /** Cost guard for one query. */
  readonly maxBudgetUsd?: number;
  /** Test seam — defaults to the real SDK `query`. */
  readonly queryFn?: QueryFn;
  /** Test seam — fetch issue by ID. */
  readonly fetchIssue?: (issueId: IssueId, projectKey: ProjectKey) => Promise<Issue | null>;
}

/**
 * The skills required by the pipeline. Each becomes a native SDK
 * sub-agent definition (Plan 18a). @ci is conditional at runtime —
 * the parent only invokes it when @coder reports changed_files —
 * but its definition is loaded up front so the SDK has the sub-
 * agent declared when the parent needs to call `Agent`.
 */
const REQUIRED_SKILLS = SUB_AGENT_NAMES;

/**
 * PipelineAgentRunner orchestrates the sub-agent pipeline.
 *
 * On each `run()` call:
 * 1. Loads required skills (repo override → bundled default)
 * 2. Builds the orchestration prompt with issue context + skills
 * 3. Runs ClaudeAgent with the prompt
 * 4. Forwards all events to the orchestrator
 */
export class PipelineAgentRunner implements AgentRunner {
  private readonly linearClient: LinearClient;
  private readonly logger: Logger;
  private readonly projectDispatch: ReadonlyMap<ProjectKey, ProjectDispatchInfo>;
  private readonly model: string | undefined;
  private readonly maxModelRoundTrips: number | undefined;
  private readonly maxBudgetUsd: number | undefined;
  private readonly queryFn: QueryFn | undefined;
  private readonly fetchIssue:
    | ((issueId: IssueId, projectKey: ProjectKey) => Promise<Issue | null>)
    | undefined;

  constructor(args: PipelineAgentRunnerArgs) {
    this.linearClient = args.linearClient;
    this.logger = args.logger;
    this.projectDispatch = args.projectDispatch;
    this.model = args.model;
    this.maxModelRoundTrips = args.maxModelRoundTrips;
    this.maxBudgetUsd = args.maxBudgetUsd;
    this.queryFn = args.queryFn;
    this.fetchIssue = args.fetchIssue;
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const log = this.logger.with({
      issue_identifier: input.issueIdentifier,
      issue_id: input.issueId,
    });

    log.info('pipeline_run_started', { attempt: input.attempt });

    // Extract project key from workspace path.
    // Path format: <root>/<projectKey>/<issueId>/
    const projectKey = this.extractProjectKey(input.workspacePath);
    if (projectKey === null) {
      log.error('pipeline_invalid_workspace_path', { path: input.workspacePath });
      yield this.failedEvent('Could not determine project key from workspace path');
      return;
    }

    // Get project dispatch info.
    const dispatchInfo = this.projectDispatch.get(projectKey);
    if (dispatchInfo === undefined) {
      log.error('pipeline_unknown_project', { project_key: projectKey });
      yield this.failedEvent(`Unknown project: ${projectKey}`);
      return;
    }

    // Load skills. For now, we pass null as repoPath since the repo
    // isn't cloned yet — @sandbox does the clone. Future improvement:
    // if the workspace already has a clone (from a previous attempt),
    // use that for skill discovery.
    let skills: Map<string, SkillDefinition>;
    try {
      skills = await loadSkills([...REQUIRED_SKILLS], null);
      log.info('pipeline_skills_loaded', {
        skills: [...skills.keys()],
        sources: [...skills.values()].map((s) => ({ name: s.name, source: s.source })),
      });
    } catch (error) {
      if (error instanceof SkillNotFoundError) {
        log.error('pipeline_skill_not_found', {
          skill: error.skillName,
          searched: error.searchedPaths,
        });
        yield this.failedEvent(`Skill not found: ${error.skillName}`);
        return;
      }
      throw error;
    }

    // Build issue context for the prompt.
    // The `input.prompt` from the orchestrator is the legacy workflow.md
    // content — we ignore it and build our own pipeline prompt.
    const issue = await this.getIssueContext(input, projectKey);
    if (issue === null) {
      log.error('pipeline_issue_not_found', { issue_id: input.issueId });
      yield this.failedEvent('Could not fetch issue context');
      return;
    }

    // Plan 18a: parent agent's system prompt is small (issue context
    // + pipeline shape + close-out instructions). Each skill becomes
    // a native SDK sub-agent definition; the parent dispatches them
    // via the `Agent` tool.
    const parentPrompt = buildParentPrompt({
      issue,
      repoUrl: dispatchInfo.repoUrl,
      defaultBranch: dispatchInfo.defaultBranch,
      branchPrefix: dispatchInfo.branchPrefix,
    });
    const subAgents = buildSubAgents(skills);

    log.info('pipeline_prompt_built', {
      parent_prompt_length: parentPrompt.length,
      sub_agent_names: Object.keys(subAgents),
      // Sum of each sub-agent's prompt length, for a sense of how
      // much only-on-invocation content we deferred out of the
      // parent prompt. Pre-18a this would have been inlined upfront.
      sub_agent_total_prompt_length: Object.values(subAgents).reduce(
        (sum, def) => sum + def.prompt.length,
        0,
      ),
    });

    // Construct ClaudeAgent with the parent's orchestration prompt
    // + the SDK-native sub-agent definitions. The parent never edits
    // files or runs shell commands directly — those tools are scoped
    // to the sub-agents (see `sub-agents.ts`).
    const agentArgs: ClaudeAgentArgs = {
      linearClient: this.linearClient,
      skillMarkdown: parentPrompt,
      agents: subAgents,
      logger: this.logger,
      ...(this.model !== undefined && { model: this.model }),
      ...(this.maxModelRoundTrips !== undefined && { maxModelRoundTrips: this.maxModelRoundTrips }),
      ...(this.maxBudgetUsd !== undefined && { maxBudgetUsd: this.maxBudgetUsd }),
      ...(this.queryFn !== undefined && { queryFn: this.queryFn }),
    };

    const agent = new ClaudeAgent(agentArgs);

    // Forward events as they arrive but accumulate the agent's text
    // output so we can post-validate the @sandbox stage's JSON handoff
    // (ADR 0014 Decision 4: skill outputs are zod-validated at the
    // boundary). We buffer the terminal event so that, if a successful
    // `turn_completed` arrives but the agent never produced a valid
    // `SandboxHandle`, we reclassify the run as `turn_failed` before
    // the orchestrator commits success state.
    //
    // Plan 18a: with `forwardSubagentText: true` set on the SDK
    // (see ClaudeAgent), the parent stream now also carries the
    // sub-agents' assistant text. The SandboxHandle JSON the
    // @sandbox sub-agent emits lands here just like before, only
    // produced by a more focused context.
    const assistantText: string[] = [];
    let bufferedTerminal: AgentEvent | null = null;

    for await (const event of agent.run({ ...input, prompt: parentPrompt })) {
      if (event.kind === 'notification') {
        // Thinking blocks are prefixed by event-mapping.ts; the
        // canonical SandboxHandle output is in plain assistant text,
        // not the model's internal reasoning.
        if (!event.message.startsWith('[thinking]')) {
          assistantText.push(event.message);
        }
        yield event;
      } else if (event.kind === 'turn_completed' || event.kind === 'turn_failed') {
        bufferedTerminal = event;
      } else {
        yield event;
      }
    }

    if (bufferedTerminal === null) {
      log.warn('pipeline_no_terminal_from_agent', {});
      yield this.failedEvent('Pipeline agent closed without a terminal event');
      return;
    }

    if (bufferedTerminal.kind === 'turn_failed') {
      // Agent already failed for its own reason — preserve it, don't
      // try to validate output that may not exist.
      log.info('pipeline_run_ended', { attempt: input.attempt, outcome: 'turn_failed' });
      yield bufferedTerminal;
      return;
    }

    const combined = assistantText.join('\n\n');
    const search = findSandboxHandleInText(combined);
    if (!search.found) {
      log.error('pipeline_sandbox_handle_invalid', {
        reason: search.reason,
        text_length: combined.length,
      });
      yield this.failedEvent(`SandboxHandle validation failed: ${search.reason}`);
      return;
    }

    log.info('pipeline_sandbox_handle_validated', {
      sandbox_id: search.handle.id,
      sandbox_kind: search.handle.kind,
      worktree_path: search.handle.worktree_path,
    });
    log.info('pipeline_run_ended', { attempt: input.attempt, outcome: 'turn_completed' });
    yield bufferedTerminal;
  }

  /**
   * Extract project key from workspace path.
   * Expected format: <root>/<projectKey>/<issueId>/
   */
  private extractProjectKey(workspacePath: string): ProjectKey | null {
    const parts = workspacePath.split('/').filter((p) => p.length > 0);
    // We need at least 2 parts: projectKey and issueId
    if (parts.length < 2) return null;
    // Project key is second-to-last
    return parts[parts.length - 2] as ProjectKey;
  }

  /**
   * Get issue context for the prompt. Uses the test seam if provided,
   * otherwise builds a minimal issue from the input.
   */
  private async getIssueContext(
    input: AgentRunInput,
    projectKey: ProjectKey,
  ): Promise<Issue | null> {
    if (this.fetchIssue !== undefined) {
      return this.fetchIssue(input.issueId, projectKey);
    }

    // Build the issue context from the AgentRunInput fields the
    // orchestrator threads through. Title, description, url, and
    // labels are populated from the actual issue; fields that don't
    // affect prompt rendering (priority, state, blockers, timestamps)
    // are left at sensible defaults — Plan 18's @coder may need more.
    return {
      id: input.issueId,
      identifier: input.issueIdentifier,
      title: input.title,
      description: input.description,
      priority: null,
      state: 'In Progress',
      branchName: null,
      url: input.url,
      labels: input.labels,
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      projectKey,
    };
  }

  private failedEvent(reason: string): AgentEvent {
    return { kind: 'turn_failed', reason, at: new Date() };
  }
}
