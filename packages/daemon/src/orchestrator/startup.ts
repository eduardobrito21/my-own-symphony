// Startup terminal workspace cleanup per SPEC §8.6.
//
// Runs once before the first poll tick. Asks the tracker for every
// issue currently in a terminal state and removes the corresponding
// workspace directory. This prevents stale workspaces from
// accumulating after restarts (e.g. you finished SYMP-1 yesterday,
// the daemon shut down, the issue moved to Done, on next start we
// reap the workspace).
//
// Failure is non-fatal: we log a warning and continue startup. SPEC
// §11.4 explicitly says "Startup terminal cleanup failure: log
// warning and continue startup."

import type { ServiceConfig } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';
import type { Tracker } from '../tracker/tracker.js';
import type { WorkspaceManager } from '../workspace/index.js';

export interface StartupCleanupArgs {
  readonly tracker: Tracker;
  readonly workspaceManager: WorkspaceManager;
  readonly config: ServiceConfig;
  readonly logger: Logger;
}

/**
 * Sweep terminal-state workspaces. Best-effort; never throws.
 */
export async function startupTerminalCleanup(args: StartupCleanupArgs): Promise<void> {
  const { tracker, workspaceManager, config, logger } = args;
  const result = await tracker.fetchIssuesByStates({
    states: config.tracker.terminal_states,
  });
  if (!result.ok) {
    logger.warn('startup terminal cleanup failed; continuing startup', {
      error_code: result.error.code,
    });
    return;
  }

  if (result.value.length === 0) {
    logger.info('startup terminal cleanup: no terminal issues to sweep');
    return;
  }

  let cleaned = 0;
  for (const issue of result.value) {
    try {
      await workspaceManager.removeForTerminal(issue.identifier);
      cleaned += 1;
    } catch (cause) {
      logger.warn('failed to remove terminal workspace; continuing', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        cause,
      });
    }
  }
  logger.info('startup terminal cleanup complete', {
    candidates: result.value.length,
    cleaned,
  });
}
