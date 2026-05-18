// Symphony daemon entry point — composition root.
//
// Loads `symphony.yaml`, constructs every collaborator, wires the
// orchestrator, performs SPEC §8.6 startup terminal-workspace
// cleanup, and starts the polling loop. SIGINT/SIGTERM trigger a
// graceful shutdown.
//
// The PipelineAgentRunner orchestrates the @sandbox → @planner →
// @coder → @curator → @ci stages via the Claude Agent SDK running
// in the daemon process (or, for namespace-backed sandboxes, by
// Bash-dispatching `claude -p` inside the agent container — see
// Plan 18b).
//
// Usage:
//   symphony                          # ./symphony.yaml
//   symphony path/to/symphony.yaml

import { env, exit, stderr, argv } from 'node:process';
import { resolve } from 'node:path';

import { PipelineAgentRunner, type ProjectDispatchInfo } from './agent/pipeline/index.js';
import type { AgentRunner } from './agent/runner.js';
import { formatWorkflowError } from './config/errors.js';
import { loadDeployment } from './config/deployment-loader.js';
import type { ServiceConfig } from './config/schema.js';
import { startHttpServer, type RunningHttpServer } from './http/server.js';
import { createConsoleLogger, type Logger } from './observability/index.js';
import { Orchestrator } from './orchestrator/index.js';
import { type ProjectContext, type ProjectContextMap } from './orchestrator/project.js';
import { startupTerminalCleanup } from './orchestrator/startup.js';
import { LinearClient, LinearTracker } from './tracker/linear/index.js';
import { sanitizeProjectSlug, type ProjectKey } from './types/index.js';
import { WorkspaceManager } from './workspace/index.js';

async function main(): Promise<number> {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith('-'));
  if (positional.length > 1) {
    stderr.write('usage: symphony [path-to-symphony.yaml]\n');
    return 2;
  }
  const deploymentPath = resolve(positional[0] ?? './symphony.yaml');
  const logger = createConsoleLogger();

  // ---- Deployment ----
  const loaded = await loadDeployment(deploymentPath);
  if (!loaded.ok) {
    stderr.write(`${formatWorkflowError(loaded.error)}\n`);
    return 1;
  }
  const deployment = loaded.value.config;
  logger.info('deployment loaded', {
    deployment_path: deploymentPath,
    project_count: deployment.projects.length,
  });

  // ---- API keys ----
  const linearApiKey = env['LINEAR_API_KEY'];
  if (linearApiKey === undefined || linearApiKey === '') {
    logger.error('LINEAR_API_KEY env var is required (set via your .env file)');
    return 1;
  }

  // Claude SDK reads ANTHROPIC_API_KEY from env automatically; we
  // check it early to fail fast with a clear error message.
  if (env['ANTHROPIC_API_KEY'] === undefined || env['ANTHROPIC_API_KEY'] === '') {
    logger.error('ANTHROPIC_API_KEY env var is required for the Claude Agent SDK');
    return 1;
  }

  // ---- Linear client (host-side, daemon's poll loop) ----
  const linearClient = new LinearClient({
    apiKey: linearApiKey,
    endpoint: 'https://api.linear.app/graphql',
  });

  // ---- Workspace manager ----
  const workspaceManager = new WorkspaceManager({
    root: deployment.workspace.root,
    logger,
  });
  logger.info('workspace manager ready', { root: deployment.workspace.root });

  // ---- Per-project trackers + dispatch info ----
  const projectsMap = new Map<ProjectKey, ProjectContext>();
  const projectDispatch = new Map<ProjectKey, ProjectDispatchInfo>();

  for (const entry of deployment.projects) {
    const key = sanitizeProjectSlug(entry.linear.project_slug);
    if (projectsMap.has(key)) {
      logger.error('duplicate project key in deployment', { project_key: key });
      return 1;
    }
    const tracker = new LinearTracker({
      client: linearClient,
      projectSlug: entry.linear.project_slug,
    });
    projectsMap.set(key, {
      key,
      tracker,
      activeStates: entry.linear.active_states,
      terminalStates: entry.linear.terminal_states,
      // Lowercase here so the eligibility check can do a fast
      // case-insensitive `Set.has` against `issue.labels` (which
      // the Linear normalizer already lowercases).
      excludedLabels: entry.linear.excluded_labels.map((s) => s.toLowerCase()),
      inProgressState: entry.linear.in_progress_state,
    });
    projectDispatch.set(key, {
      repoUrl: entry.repo.url,
      defaultBranch: entry.repo.default_branch,
      branchPrefix: entry.repo.branch_prefix,
      // First entry of excluded_labels is the escalation label —
      // the close-out flow adds this label to the issue on failure
      // and the next poll's filter sees it and skips. Same name on
      // both sides of the loop, single source of truth: symphony.yaml.
      // Preserve the operator's original casing (not lowercased) so
      // the label that gets added to Linear matches what they see in
      // the UI; the filter normalizes on its side.
      escalationLabel: entry.linear.excluded_labels[0] ?? null,
    });
    logger.info('project ready', {
      project_key: key,
      project_slug: entry.linear.project_slug,
      repo_url: entry.repo.url,
    });
  }
  if (projectsMap.size === 0) {
    logger.error('symphony.yaml declares no projects');
    return 1;
  }
  const projects: ProjectContextMap = projectsMap;

  // ---- Agent runner: PipelineAgentRunner (Plan 16) ----
  const agent: AgentRunner = new PipelineAgentRunner({
    linearClient,
    logger,
    projectDispatch,
    model: deployment.agent.model,
    ...(deployment.agent.max_model_round_trips !== undefined && {
      maxModelRoundTrips: deployment.agent.max_model_round_trips,
    }),
    ...(deployment.agent.max_budget_usd !== undefined && {
      maxBudgetUsd: deployment.agent.max_budget_usd,
    }),
  });
  logger.info('pipeline agent runner ready', {
    model: deployment.agent.model,
    max_model_round_trips: deployment.agent.max_model_round_trips,
  });

  // ---- Orchestrator config (synthesized from DeploymentConfig) ----
  const serviceConfig: ServiceConfig = {
    tracker: {
      endpoint: 'https://api.linear.app/graphql',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
    },
    polling: { interval_ms: deployment.polling.interval_ms },
    workspace: { root: deployment.workspace.root },
    hooks: { timeout_ms: deployment.hooks.timeout_ms },
    agent: {
      model: deployment.agent.model,
      thinking: { type: 'disabled' },
      max_concurrent_agents: deployment.agent.max_concurrent_agents,
      max_turns: deployment.agent.max_turns,
      ...(deployment.agent.max_model_round_trips !== undefined && {
        max_model_round_trips: deployment.agent.max_model_round_trips,
      }),
      ...(deployment.agent.max_budget_usd !== undefined && {
        max_budget_usd: deployment.agent.max_budget_usd,
      }),
      max_retry_backoff_ms: deployment.agent.max_retry_backoff_ms,
      max_concurrent_agents_by_state: deployment.agent.max_concurrent_agents_by_state,
      turn_timeout_ms: deployment.agent.turn_timeout_ms,
      read_timeout_ms: deployment.agent.read_timeout_ms,
      stall_timeout_ms: deployment.agent.stall_timeout_ms,
    },
  };

  // The PipelineAgentRunner builds its own orchestration prompt from
  // loaded skills. This placeholder satisfies the Orchestrator constructor
  // signature; the actual prompt is built inside PipelineAgentRunner.run().
  const promptTemplateSource = '{{ issue.identifier }}: {{ issue.title }}';

  // ---- Orchestrator ----
  const orchestrator = new Orchestrator({
    config: serviceConfig,
    promptTemplateSource,
    projects,
    workspaceManager,
    agent,
    logger,
  });

  // ---- Startup terminal-workspace cleanup (SPEC §8.6) ----
  await startupTerminalCleanup({ projects, workspaceManager, logger });

  // ---- Optional HTTP server ----
  const httpServer = await maybeStartHttpServer(orchestrator, logger);

  // ---- Signal handling ----
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('signal received', { signal });
    const settled: Promise<unknown>[] = [orchestrator.stop()];
    if (httpServer !== null) settled.push(httpServer.close());
    void Promise.allSettled(settled).then(() => {
      logger.info('clean shutdown complete');
      setTimeout(() => {
        exit(0);
      }, 50);
    });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  orchestrator.start();
  return await new Promise<number>(() => {
    // Never resolves — the signal handler exits the process.
  });
}

/**
 * Start the optional HTTP server if the operator opted in via env.
 *
 *   SYMPHONY_HTTP_PORT=3000        # required to enable; unset = off
 *   SYMPHONY_HTTP_HOST=127.0.0.1   # optional; defaults to loopback
 */
async function maybeStartHttpServer(
  orchestrator: Orchestrator,
  logger: Logger,
): Promise<RunningHttpServer | null> {
  const portRaw = env['SYMPHONY_HTTP_PORT'];
  if (portRaw === undefined || portRaw.trim() === '') return null;
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65_535) {
    logger.error('SYMPHONY_HTTP_PORT is not a valid port; HTTP server disabled', {
      value: portRaw,
    });
    return null;
  }
  const host = env['SYMPHONY_HTTP_HOST'] ?? '127.0.0.1';
  try {
    return await startHttpServer({
      port,
      host,
      getSnapshot: () => orchestrator.snapshot(),
      daemonStartedAt: new Date(),
      logger,
    });
  } catch (cause) {
    logger.error('failed to start HTTP server; continuing without it', {
      port,
      host,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

await main().then((code) => {
  exit(code);
});
