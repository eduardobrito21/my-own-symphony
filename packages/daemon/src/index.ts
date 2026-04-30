// Symphony daemon entry point — composition root.
//
// Loads `symphony.yaml`, constructs every collaborator, wires the
// orchestrator, performs SPEC §8.6 startup terminal-workspace
// cleanup, and starts the polling loop. SIGINT/SIGTERM trigger a
// graceful shutdown.
//
// The single supported config format is `symphony.yaml` (multi-
// project deployment, ADR 0009 + Plan 10). The legacy `WORKFLOW.md`
// pipeline was removed in the Plan 10 consolidation — there is now
// one routine, "the basic case": daemon polls Linear projects per
// `symphony.yaml`, dispatches work to the configured execution
// backend.
//
// `execution.backend` selects how the agent runs:
//
//   - `local-docker` (default): per-issue Docker pod via
//     `LocalDockerBackend` + `BackendAgentRunner`. Production target.
//   - `in-process`: the daemon constructs `ClaudeAgent` and runs
//     it in its own process. No docker, no isolation. Useful for
//     local development against a single repo without the image-
//     build cycle.
//
// Usage:
//   symphony                          # ./symphony.yaml
//   symphony path/to/symphony.yaml

import { env, exit, stderr, argv } from 'node:process';
import { resolve } from 'node:path';

import { ClaudeAgent } from './agent/claude/agent.js';
import { LINEAR_SKILL_MARKDOWN } from './agent/claude/linear-skill-loader.js';
import { BackendAgentRunner, type ProjectDispatchInfo } from './agent/backend/backend-runner.js';
import type { AgentRunner } from './agent/runner.js';
import { formatWorkflowError } from './config/errors.js';
import { loadDeployment } from './config/deployment-loader.js';
import type { DeploymentConfig } from './config/deployment.js';
import type { ServiceConfig } from './config/schema.js';
import { LocalDockerBackend } from './execution/index.js';
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
    backend: deployment.execution.backend,
  });

  // ---- Linear client (host-side, daemon's poll loop) ----
  // The pod constructs its own LinearClient inside the container
  // when `backend: local-docker`. This one is for the host daemon's
  // poll/reconcile loop and is also handed to ClaudeAgent for the
  // `in-process` backend.
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
  // Multi-project namespacing is supported in WorkspaceManager
  // (Plan 09c). Per-repo hook bodies live in `.symphony/workflow.md`
  // and the pod executes them; here we only carry the timeout.
  const workspaceManager = new WorkspaceManager({
    root: deployment.workspace.root,
    hooks: { timeout_ms: deployment.hooks.timeout_ms },
    logger,
  });
  logger.info('workspace manager ready', { root: deployment.workspace.root });

  // ---- Per-project trackers + dispatch info ----
  const projectsMap = new Map<ProjectKey, ProjectContext>();
  const dispatchMap = new Map<ProjectKey, ProjectDispatchInfo>();
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
    dispatchMap.set(key, {
      trackerProjectSlug: entry.linear.project_slug,
      repo: {
        url: entry.repo.url,
        defaultBranch: entry.repo.default_branch,
        workflowPath: entry.repo.workflow_path,
        branchPrefix: entry.repo.branch_prefix,
        ...(entry.repo.agent_image !== undefined && {
          explicitImageTag: entry.repo.agent_image,
        }),
      },
    });
    logger.info('project ready', {
      project_key: key,
      project_slug: entry.linear.project_slug,
      repo_url: entry.repo.url,
      ...(entry.repo.agent_image !== undefined && { agent_image: entry.repo.agent_image }),
    });
  }
  if (projectsMap.size === 0) {
    logger.error('symphony.yaml declares no projects');
    return 1;
  }
  const projects: ProjectContextMap = projectsMap;

  // ---- Agent runner (per `execution.backend`) ----
  const agent = buildAgent(deployment, dispatchMap, linearClient, logger);
  if (agent === null) return 1;

  // ---- Orchestrator config (synthesized from DeploymentConfig) ----
  // The orchestrator was built around the legacy ServiceConfig
  // shape; we map deployment-mode fields onto it. The orchestrator
  // only reads `polling`, `workspace`, `hooks`, and `agent` blocks
  // — the `tracker.*` fields here are unused (per-project trackers
  // are passed via `projects`).
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

  // The orchestrator hands its rendered prompt to `agent.run()`. In
  // `local-docker` mode the pod re-renders from
  // `<repo>/.symphony/workflow.md` (per ADR 0011), so this template
  // is a placeholder — `BackendAgentRunner` discards it. In
  // `in-process` mode the daemon has no per-repo workflow.md
  // available (no clone), so we render the **basic-case** smoke
  // prompt: post a comment, transition to Done. Repos that need
  // richer per-issue prompts (real code edits, hooks, custom
  // tools) should run with `local-docker`.
  const promptTemplateSource =
    deployment.execution.backend === 'in-process'
      ? [
          'You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.',
          '',
          'This is the Symphony "basic case" smoke loop. Do exactly two things:',
          '',
          '1. Use the `linear_graphql` tool to post a comment on this issue with',
          '   the body: `hello from symphony 👋 (in-process)`. The mutation is',
          '   `commentCreate(input: { issueId: "{{ issue.id }}", body: "..." })`.',
          "2. Use `linear_graphql` to look up the issue's team workflow states",
          '   (`workflowStates(filter: { team: { id: { eq: "<teamId>" } } })`),',
          '   find the one named `Done`, and transition the issue via',
          '   `issueUpdate(id: "{{ issue.id }}", input: { stateId: "..." })`.',
          '',
          'Do not edit code. Do not open a PR. End the run after both steps.',
        ].join('\n')
      : '<rendered in-pod from .symphony/workflow.md>';

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
 * Construct the right `AgentRunner` based on the deployment's
 * `execution.backend` selector. Returns `null` (and logs `error`)
 * on misconfiguration so the caller can exit nonzero before the
 * orchestrator starts.
 */
function buildAgent(
  deployment: DeploymentConfig,
  projectDispatch: ReadonlyMap<ProjectKey, ProjectDispatchInfo>,
  linearClient: LinearClient,
  logger: Logger,
): AgentRunner | null {
  const backendKind = deployment.execution.backend;

  if (backendKind === 'in-process') {
    if (!hasNonEmptyEnv('ANTHROPIC_API_KEY')) {
      logger.error('execution.backend=in-process requires ANTHROPIC_API_KEY in the environment');
      return null;
    }
    logger.info('execution backend: in-process (ClaudeAgent runs in daemon process)', {
      model: deployment.agent.model,
    });
    return new ClaudeAgent({
      linearClient,
      skillMarkdown: LINEAR_SKILL_MARKDOWN,
      logger,
      model: deployment.agent.model,
      ...(deployment.agent.max_model_round_trips !== undefined && {
        maxModelRoundTrips: deployment.agent.max_model_round_trips,
      }),
      ...(deployment.agent.max_budget_usd !== undefined && {
        maxBudgetUsd: deployment.agent.max_budget_usd,
      }),
    });
  }

  // `local-docker` (default).
  logger.info('execution backend: local-docker', {
    base_image: deployment.execution.base_image,
  });
  const backend = new LocalDockerBackend({
    baseImage: deployment.execution.base_image,
    logger,
  });

  // Pod env: secrets the in-pod entrypoint reads. The daemon
  // forwards whatever's in its own process env (sourced from `.env`).
  const linearApiKey = env['LINEAR_API_KEY'] ?? '';
  const podEnv: Record<string, string> = { LINEAR_API_KEY: linearApiKey };
  const anthropicKey = env['ANTHROPIC_API_KEY'];
  if (anthropicKey !== undefined && anthropicKey !== '') {
    podEnv['ANTHROPIC_API_KEY'] = anthropicKey;
  } else {
    logger.warn(
      'ANTHROPIC_API_KEY missing from env — pods will fail when the SDK tries to call Anthropic',
    );
  }
  const githubToken = env['GITHUB_TOKEN'];
  if (githubToken !== undefined && githubToken !== '') {
    podEnv['GITHUB_TOKEN'] = githubToken;
  }

  return new BackendAgentRunner({
    backend,
    projectDispatch,
    operatorCaps: {
      model: deployment.agent.model,
      ...(deployment.agent.max_model_round_trips !== undefined && {
        maxTurns: deployment.agent.max_model_round_trips,
      }),
      ...(deployment.agent.max_budget_usd !== undefined && {
        maxBudgetUsd: deployment.agent.max_budget_usd,
      }),
    },
    baseImage: deployment.execution.base_image,
    env: podEnv,
    logger,
  });
}

/**
 * Start the optional HTTP server if the operator opted in via env.
 * Configuration lives in env vars rather than `symphony.yaml`
 * because port + host are **deployment** decisions (where this
 * particular daemon listens), not workflow decisions. Mixing the
 * two would make `symphony.yaml` non-portable across daemon
 * instances.
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

function hasNonEmptyEnv(name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}

await main().then((code) => {
  exit(code);
});
