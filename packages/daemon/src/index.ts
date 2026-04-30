// Symphony daemon entry point — composition root.
//
// Loads `WORKFLOW.md`, constructs every collaborator, wires the
// orchestrator, performs SPEC §8.6 startup terminal-workspace
// cleanup, installs a `WORKFLOW.md` watcher for dynamic reload
// (SPEC §6.2), and starts the polling loop. SIGINT/SIGTERM trigger
// a graceful shutdown.
//
// Plan 05 scope: real reconciliation + retries + reload. Linear
// arrives in Plan 06; real Claude in Plan 07.
//
// Usage:
//   symphony [path/to/WORKFLOW.md]
//
// Defaults to `./WORKFLOW.md` per SPEC §5.1.

import { env, exit, stderr, stdout, argv } from 'node:process';
import { resolve } from 'node:path';

import { ClaudeAgent } from './agent/claude/agent.js';
import { LINEAR_SKILL_MARKDOWN } from './agent/claude/linear-skill-loader.js';
import { MockAgent } from './agent/mock/index.js';
import type { AgentRunner } from './agent/runner.js';
import { formatWorkflowError } from './config/errors.js';
import { loadWorkflow } from './config/loader.js';
import type { ServiceConfig } from './config/schema.js';
import { WorkflowWatcher } from './config/watch.js';
import { startHttpServer, type RunningHttpServer } from './http/server.js';
import { createConsoleLogger, type Logger } from './observability/index.js';
import { Orchestrator } from './orchestrator/index.js';
import { singleProjectContext } from './orchestrator/project.js';
import { startupTerminalCleanup } from './orchestrator/startup.js';
import { FakeTracker, loadFixture } from './tracker/fake/index.js';
import { LinearClient, LinearTracker } from './tracker/linear/index.js';
import type { Tracker } from './tracker/tracker.js';
import { ProjectKey } from './types/index.js';
import { WorkspaceManager } from './workspace/index.js';

async function main(): Promise<number> {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith('-'));
  if (positional.length > 1) {
    stderr.write('usage: symphony [path-to-WORKFLOW.md]\n');
    return 2;
  }

  const workflowPath = resolve(positional[0] ?? './WORKFLOW.md');
  const logger = createConsoleLogger();

  // ---- Workflow ----
  const workflowResult = await loadWorkflow(workflowPath);
  if (!workflowResult.ok) {
    stderr.write(`${formatWorkflowError(workflowResult.error)}\n`);
    return 1;
  }
  const { config, promptTemplate } = workflowResult.value;
  logger.info('workflow loaded', {
    workflow_path: workflowPath,
    tracker_kind: config.tracker.kind ?? '<unset>',
  });

  // ---- Linear client (shared by tracker + agent tool, when wired) ----
  // We build at most one `LinearClient`. Both the LinearTracker
  // (read-only polling) and the ClaudeAgent's `linear_graphql` tool
  // (read+write) talk through this single instance, so auth, transport,
  // and error handling all live in one place. See ADR 0002 + Plan 07
  // decision log entry "Reusing LinearClient between tracker and tool".
  const linearClient = maybeBuildLinearClient(config, workflowPath, logger);

  // ---- Tracker ----
  const tracker = await buildTracker(config, workflowPath, logger, linearClient);
  if (tracker === null) return 1;

  // ---- Workspace manager ----
  const workspaceManager = new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.hooks,
    logger,
  });
  logger.info('workspace manager ready', { root: config.workspace.root });

  // ---- Agent ----
  // Plan 07 introduces a backend selector. Default is `mock` for back-
  // compat with pre-Plan-07 workflows; `claude` switches to the real
  // Claude Agent SDK runner.
  const agent = buildAgent(config, logger, linearClient);
  if (agent === null) return 1;

  // ---- Orchestrator ----
  // Single-project compat mode (Plan 09c): synthesize a one-entry
  // ProjectContextMap from the legacy WORKFLOW.md's tracker config.
  // The synthesized project key is `default`. Multi-project loading
  // from `symphony.yaml` is wired in a follow-up; this entrypoint
  // stays back-compat with positional `pnpm symphony WORKFLOW.md`.
  const projects = singleProjectContext({
    key: ProjectKey('default'),
    tracker,
    activeStates: config.tracker.active_states,
    terminalStates: config.tracker.terminal_states,
  });
  const orchestrator = new Orchestrator({
    config,
    promptTemplateSource: promptTemplate,
    projects,
    workspaceManager,
    agent,
    logger,
  });

  // ---- Startup terminal-workspace cleanup (SPEC §8.6) ----
  // Runs once before the first tick. Prevents stale workspaces from
  // accumulating across restarts.
  await startupTerminalCleanup({
    projects,
    workspaceManager,
    logger,
  });

  // ---- Workflow file watcher (SPEC §6.2 dynamic reload) ----
  const watcher = new WorkflowWatcher({
    path: workflowPath,
    onReload: async (def) => {
      await orchestrator.applyWorkflow(def);
    },
    onError: (err) => {
      logger.error('workflow reload failed; keeping last-known-good config', {
        code: err.code,
        message: err.message,
      });
    },
  });
  logger.info('watching workflow for changes', { workflow_path: workflowPath });

  // ---- Optional HTTP server (Plan 08a) ----
  // Off by default. Set SYMPHONY_HTTP_PORT in your env (e.g. in `.env`)
  // to expose the read-only state endpoint for the dashboard or curl.
  // Deliberately not in WORKFLOW.md — port + host are deployment
  // decisions, not workflow decisions.
  const httpServer = await maybeStartHttpServer(orchestrator, logger);

  // ---- Signal handling ----
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('signal received', { signal });
    const settled = [orchestrator.stop(), watcher.close()];
    if (httpServer !== null) settled.push(httpServer.close());
    void Promise.allSettled(settled).then(() => {
      logger.info('clean shutdown complete');
      // Use a small delay so the final log line flushes before
      // process.exit short-circuits stderr buffering.
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
  // The process stays alive because the timer keeps the event loop
  // busy. We do not `await` orchestrator.stop() here — it's only
  // called from the signal handler.
  return await new Promise<number>(() => {
    // Never resolves on the happy path; the signal handler is the
    // only exit. We return a never-resolving promise so TypeScript
    // sees a Promise<number> return type.
  });
}

/**
 * Construct a `LinearClient` if either side of the daemon needs one
 * (tracker `kind=linear` OR agent `kind=claude`). Returns `null` when
 * neither side wants Linear traffic — the FakeTracker + MockAgent path
 * never touches the network, so we don't construct an unused client
 * (and don't demand `tracker.api_key` for tests).
 *
 * The same instance is then passed to both the tracker (read-only)
 * and the ClaudeAgent's `linear_graphql` tool (read+write) so auth +
 * transport stay a single source of truth (Plan 07 decision).
 */
function maybeBuildLinearClient(
  config: ServiceConfig,
  workflowPath: string,
  logger: Logger,
): LinearClient | null {
  const trackerKind = (config.tracker.kind ?? 'fake').toLowerCase();
  const agentKind = (config.agent.kind ?? 'mock').toLowerCase();
  const needsLinear = trackerKind === 'linear' || agentKind === 'claude';
  if (!needsLinear) return null;

  const apiKey = config.tracker.api_key;
  if (apiKey === undefined) {
    logger.error(
      'tracker.api_key is required when tracker.kind=linear or agent.kind=claude (use $LINEAR_API_KEY)',
      { workflow_path: workflowPath },
    );
    return null;
  }
  return new LinearClient({
    endpoint: config.tracker.endpoint,
    apiKey,
  });
}

async function buildTracker(
  config: ServiceConfig,
  workflowPath: string,
  logger: Logger,
  linearClient: LinearClient | null,
): Promise<Tracker | null> {
  const kind = (config.tracker.kind ?? 'fake').toLowerCase();
  if (kind === 'linear') {
    return buildLinearTracker(config, workflowPath, logger, linearClient);
  }
  if (kind === 'fake') {
    return await buildFakeTracker(config, logger);
  }
  logger.error('unsupported tracker.kind', { kind });
  return null;
}

function buildLinearTracker(
  config: ServiceConfig,
  workflowPath: string,
  logger: Logger,
  linearClient: LinearClient | null,
): Tracker | null {
  // SPEC §6.3 dispatch preflight: project_slug is required for
  // LinearTracker. The api_key check happens in
  // `maybeBuildLinearClient` (it covers the agent path too).
  const projectSlug = config.tracker.project_slug;
  if (projectSlug === undefined) {
    logger.error('tracker.kind=linear requires tracker.project_slug', {
      workflow_path: workflowPath,
    });
    return null;
  }
  if (linearClient === null) {
    // Should have been built upstream — defensive only.
    logger.error('internal: linear client not constructed for tracker.kind=linear', {
      workflow_path: workflowPath,
    });
    return null;
  }
  logger.info('linear tracker ready', {
    endpoint: config.tracker.endpoint,
    project_slug: projectSlug,
  });
  return new LinearTracker({ client: linearClient, projectSlug });
}

/**
 * Pick the right `AgentRunner` based on `agent.kind`:
 *
 *   - `mock` (default)  — Plan 04 fake runner, fast and offline.
 *   - `claude`          — Plan 07 real runner driven by Anthropic's
 *                         Claude Agent SDK. Requires
 *                         `ANTHROPIC_API_KEY` and a `LinearClient`.
 *
 * Returns `null` (and logs `error`) on any startup misconfiguration so
 * the caller can exit nonzero before we touch the orchestrator.
 */
function buildAgent(
  config: ServiceConfig,
  logger: Logger,
  linearClient: LinearClient | null,
): AgentRunner | null {
  const kind = (config.agent.kind ?? 'mock').toLowerCase();
  if (kind === 'mock') {
    logger.info('agent ready', { kind: 'mock' });
    return new MockAgent({
      turnDurationMs: 800,
      notifications: ['analyzing', 'planning', 'implementing'],
    });
  }
  if (kind === 'claude') {
    // The SDK reads ANTHROPIC_API_KEY from process.env on every call.
    // Failing fast here (rather than discovering the missing env var
    // mid-turn) gives operators a single, obvious startup error.
    if (!hasNonEmptyEnv('ANTHROPIC_API_KEY')) {
      logger.error(
        'agent.kind=claude requires ANTHROPIC_API_KEY in the environment (set it via your --env-file)',
      );
      return null;
    }
    if (linearClient === null) {
      logger.error(
        'agent.kind=claude requires tracker.api_key — the Linear graphql tool reuses the tracker client',
      );
      return null;
    }
    logger.info('agent ready', {
      kind: 'claude',
      model: config.agent.model,
      thinking: config.agent.thinking,
    });
    return new ClaudeAgent({
      linearClient,
      skillMarkdown: LINEAR_SKILL_MARKDOWN,
      logger,
      model: config.agent.model,
      thinking: config.agent.thinking,
      ...(config.agent.max_model_round_trips !== undefined && {
        maxModelRoundTrips: config.agent.max_model_round_trips,
      }),
      ...(config.agent.max_budget_usd !== undefined && {
        maxBudgetUsd: config.agent.max_budget_usd,
      }),
    });
  }
  logger.error('unsupported agent.kind', { kind });
  return null;
}

/**
 * Start the optional Plan 08a HTTP server if the operator opted in
 * via env. Configuration lives in env vars rather than WORKFLOW.md
 * because port + host are **deployment** decisions (where this
 * particular daemon listens), not **workflow** decisions (how the
 * agent should behave on a Linear issue). Mixing the two would
 * make WORKFLOW.md non-portable — the same workflow file can't be
 * re-run on a different daemon instance if it hard-codes a port.
 *
 *   SYMPHONY_HTTP_PORT=3000   # required to enable; unset = off
 *   SYMPHONY_HTTP_HOST=127.0.0.1   # optional; defaults to loopback
 *
 * Returns null when not enabled, so the daemon stays silent on
 * the network until an operator explicitly asks for the API.
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

async function buildFakeTracker(config: ServiceConfig, logger: Logger): Promise<Tracker | null> {
  if (config.tracker.fixture_path === undefined) {
    logger.warn('tracker.kind=fake without tracker.fixture_path; FakeTracker will be empty');
    return new FakeTracker([]);
  }
  const fixture = await loadFixture(config.tracker.fixture_path);
  if (!fixture.ok) {
    logger.error('failed to load fixture', {
      code: fixture.code,
      message: fixture.message,
      path: fixture.path,
    });
    return null;
  }
  logger.info('fixture loaded', {
    path: config.tracker.fixture_path,
    count: fixture.issues.length,
  });
  // The unused `stdout` import lint trick: keep the symbol referenced
  // so eslint doesn't complain. (We may use stdout in future demos.)
  void stdout;
  return new FakeTracker(fixture.issues);
}

await main().then((code) => {
  exit(code);
});
