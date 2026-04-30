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

import type { Logger } from '../observability/logger.js';
import type { WorkspaceManager } from '../workspace/index.js';

import type { ProjectContextMap } from './project.js';

export interface StartupCleanupArgs {
  /** Multi-project (Plan 09c). Each project's terminal-state list
   *  is queried via that project's tracker and the resulting
   *  workspaces are removed under the namespaced path. */
  readonly projects: ProjectContextMap;
  readonly workspaceManager: WorkspaceManager;
  readonly logger: Logger;
}

/**
 * Sweep terminal-state workspaces. Best-effort; never throws.
 *
 * Multi-project (Plan 09c): iterates every project, fetches its
 * own terminal issues with its own state-name list, and removes
 * each workspace under the project-namespaced path. Per-project
 * fetch failure is logged and that project is skipped — failures
 * in one project do not block the others.
 */
export async function startupTerminalCleanup(args: StartupCleanupArgs): Promise<void> {
  const { projects, workspaceManager, logger } = args;
  let totalCleaned = 0;
  let totalCandidates = 0;

  for (const ctx of projects.values()) {
    const result = await ctx.tracker.fetchIssuesByStates({
      states: ctx.terminalStates,
    });
    if (!result.ok) {
      logger.warn('startup terminal cleanup failed for project; continuing', {
        project_key: ctx.key,
        error_code: result.error.code,
      });
      continue;
    }
    totalCandidates += result.value.length;

    for (const issue of result.value) {
      try {
        await workspaceManager.removeForTerminal(issue.identifier, ctx.key);
        totalCleaned += 1;
      } catch (cause) {
        logger.warn('failed to remove terminal workspace; continuing', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          project_key: ctx.key,
          cause,
        });
      }
    }
  }

  logger.info('startup terminal cleanup complete', {
    candidates: totalCandidates,
    cleaned: totalCleaned,
    projects: projects.size,
  });
}
