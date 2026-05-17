// Symphony daemon entry point — composition root.
//
// Loads `symphony.yaml`, constructs every collaborator, wires the
// orchestrator, performs SPEC §8.6 startup terminal-workspace
// cleanup, and starts the polling loop. SIGINT/SIGTERM trigger a
// graceful shutdown.
//
// ⚠️ Post-ADR 0014 (Plan 15): the execution-backend selector and
// the per-pod agent runtime have been removed. The orchestrator
// runs with a `NoopAgentRunner` that emits `turn_failed` on every
// dispatch — the daemon still polls Linear, the dashboard still
// renders state, but dispatched issues no-op until Plan 16 wires
// the in-process Claude SDK + sub-agent pipeline.
//
// Usage:
//   symphony                          # ./symphony.yaml
//   symphony path/to/symphony.yaml

import { env, exit, stderr, argv } from 'node:process';
import { resolve } from 'node:path';

import type { AgentEvent, AgentRunInput, AgentRunner } from './agent/runner.js';
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

  // ---- Linear client (host-side, daemon's poll loop) ----
  const linearApiKey = env['LINEAR_API_KEY'];
  if (linearApiKey === undefined || linearApiKey === '') {
    logger.error('LINEAR_API_KEY env var is required (set via your .env file)');
    return 1;
  }
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

  // ---- Per-project trackers ----
  const projectsMap = new Map<ProjectKey, ProjectContext>();
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

  // ---- Agent runner: placeholder until Plan 16 ----
  // TODO Plan 16: spawn the initial sub-agent here (Claude SDK in
  // daemon process, orchestrating @infra → @app → @coder → @ci).
  // Until then, the daemon polls + renders state but dispatched
  // issues fail loudly with a "no agent wired" message rather than
  // silently no-op. This matches Plan 15's "daemon that polls but
  // doesn't dispatch" intent.
  const agent: AgentRunner = new NoopAgentRunner(logger);
  logger.warn(
    'agent runtime not wired — every dispatch will fail with "Plan 16 pending" (see ADR 0014)',
  );

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

  // Placeholder prompt template — Plan 16 will route the rendered
  // prompt through the sub-agent pipeline rather than handing a
  // single string to one runner.
  const promptTemplateSource = '<Plan 16 pending: sub-agent pipeline not wired>';

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
 * Stub `AgentRunner` used between Plan 15 (this commit, which deleted
 * the in-pod runtime + ExecutionBackend) and Plan 16 (which will wire
 * the in-process Claude SDK + sub-agent pipeline). Emits a single
 * `turn_failed` event so the orchestrator records the dispatch and
 * moves on with its retry cadence.
 */
class NoopAgentRunner implements AgentRunner {
  constructor(private readonly logger: Logger) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.logger.warn('NoopAgentRunner: refusing dispatch (Plan 16 pending)', {
      issue_identifier: input.issueIdentifier,
    });
    yield {
      kind: 'turn_failed',
      reason: 'agent runtime not wired (Plan 16 pending — see ADR 0014)',
      at: new Date(),
    };
  }
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
