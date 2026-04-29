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

import { resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import { formatWorkflowError } from './config/errors.js';
import { loadWorkflow } from './config/loader.js';
import type { ServiceConfig } from './config/schema.js';
import { WorkflowWatcher } from './config/watch.js';
import { MockAgent } from './agent/mock/index.js';
import { createConsoleLogger, type Logger } from './observability/index.js';
import { Orchestrator } from './orchestrator/index.js';
import { startupTerminalCleanup } from './orchestrator/startup.js';
import { FakeTracker, loadFixture } from './tracker/fake/index.js';
import { LinearClient, LinearTracker } from './tracker/linear/index.js';
import type { Tracker } from './tracker/tracker.js';
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

  // ---- Tracker ----
  const tracker = await buildTracker(config, workflowPath, logger);
  if (tracker === null) return 1;

  // ---- Workspace manager ----
  const workspaceManager = new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.hooks,
    logger,
  });
  logger.info('workspace manager ready', { root: config.workspace.root });

  // ---- Agent ----
  // Plan 04: only the mock agent is wired. Plan 07 will introduce
  // real Claude and a `agent.kind` switch.
  const agent = new MockAgent({
    turnDurationMs: 800,
    notifications: ['analyzing', 'planning', 'implementing'],
  });
  logger.info('agent ready', { kind: 'mock' });

  // ---- Orchestrator ----
  const orchestrator = new Orchestrator({
    config,
    promptTemplateSource: promptTemplate,
    tracker,
    workspaceManager,
    agent,
    logger,
  });

  // ---- Startup terminal-workspace cleanup (SPEC §8.6) ----
  // Runs once before the first tick. Prevents stale workspaces from
  // accumulating across restarts.
  await startupTerminalCleanup({
    tracker,
    workspaceManager,
    config,
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

  // ---- Signal handling ----
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('signal received', { signal });
    void Promise.allSettled([orchestrator.stop(), watcher.close()]).then(() => {
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

async function buildTracker(
  config: ServiceConfig,
  workflowPath: string,
  logger: Logger,
): Promise<Tracker | null> {
  const kind = (config.tracker.kind ?? 'fake').toLowerCase();
  if (kind === 'linear') {
    return buildLinearTracker(config, workflowPath, logger);
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
): Tracker | null {
  // SPEC §6.3 dispatch preflight checks. We do them here too so a
  // missing project_slug or api_key fails before we wire the
  // orchestrator at all.
  const apiKey = config.tracker.api_key;
  if (apiKey === undefined) {
    logger.error('tracker.kind=linear requires tracker.api_key (use $LINEAR_API_KEY)', {
      workflow_path: workflowPath,
    });
    return null;
  }
  const projectSlug = config.tracker.project_slug;
  if (projectSlug === undefined) {
    logger.error('tracker.kind=linear requires tracker.project_slug', {
      workflow_path: workflowPath,
    });
    return null;
  }
  const client = new LinearClient({
    endpoint: config.tracker.endpoint,
    apiKey,
  });
  logger.info('linear tracker ready', {
    endpoint: config.tracker.endpoint,
    project_slug: projectSlug,
  });
  return new LinearTracker({ client, projectSlug });
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
