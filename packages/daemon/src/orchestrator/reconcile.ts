// Tick-time reconciliation per SPEC §8.5.
//
// Two passes, in order:
//
//   A. Stall detection. For each running issue, if no agent activity
//      for `agent.stall_timeout_ms`, abort the worker. The worker's
//      abnormal exit will then schedule a failure-driven retry via
//      the normal completeWorker path. SPEC says `stall_timeout_ms <= 0`
//      disables stall detection entirely.
//
//   B. Tracker state refresh. Pull current state for every running
//      issue ID. For each:
//        - terminal state -> terminate worker, clean workspace
//        - active state   -> update issue snapshot in running entry
//        - other state    -> terminate worker, leave workspace alone
//
// `terminate` here is *not* the same as a normal abnormal exit:
// reconciliation cancellations should NOT trigger a retry. We
// communicate that via the `canceled` set on the orchestrator state.

import type { Logger } from '../observability/logger.js';
import { isStateAmong } from '../tracker/state-matching.js';
import type { IssueId, ProjectKey } from '../types/index.js';

import type { ProjectContextMap } from './project.js';
import type { MutableOrchestratorState } from './state.js';

export interface ReconcileArgs {
  readonly state: MutableOrchestratorState;
  /** Multi-project (Plan 09c): one tracker per project. Reconcile
   *  splits running issues by their stamped projectKey and calls
   *  each project's tracker for state refresh. */
  readonly projects: ProjectContextMap;
  /** Daemon-wide stall timeout (per SPEC §5.3.6 / config). `<= 0`
   *  disables stall detection. */
  readonly stallTimeoutMs: number;
  readonly logger: Logger;
  /** Called for each issue the reconciler decides to terminate. */
  readonly onTerminate: (issueId: IssueId, opts: { cleanupWorkspace: boolean }) => void;
  /** Called for each running issue that has stalled. Aborts the worker. */
  readonly onStall: (issueId: IssueId) => void;
  /** Override the wall clock for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Run both reconciliation passes. The orchestrator calls this at the
 * top of every tick while holding its lock.
 */
export async function reconcile(args: ReconcileArgs): Promise<void> {
  reconcileStalledRuns(args);
  await reconcileTrackerStates(args);
}

/**
 * Pass A. Detect and abort stalled workers. Disabled when
 * `stallTimeoutMs <= 0`.
 */
export function reconcileStalledRuns(args: ReconcileArgs): void {
  const { state, stallTimeoutMs, logger, onStall } = args;
  if (stallTimeoutMs <= 0) return;

  const now = (args.now ?? (() => new Date()))();

  for (const [id, entry] of state.running) {
    const lastActivity = entry.session.lastAgentTimestamp ?? entry.startedAt;
    const elapsedMs = now.getTime() - lastActivity.getTime();
    if (elapsedMs > stallTimeoutMs) {
      logger.warn('stall detected; aborting worker', {
        issue_id: id,
        issue_identifier: entry.issue.identifier,
        elapsed_ms: elapsedMs,
        stall_timeout_ms: stallTimeoutMs,
      });
      onStall(id);
    }
  }
}

/**
 * Pass B. Refresh tracker states for every running issue and act on
 * the result.
 *
 * Multi-project (Plan 09c): groups running IDs by `projectKey` and
 * fans out to per-project trackers in parallel. Each project's
 * tracker uses that project's `active_states`/`terminal_states`
 * vocabulary for the active/terminal classification.
 *
 * On per-project fetch failure we keep that project's workers
 * running and try again next tick (SPEC §8.5: "If state refresh
 * fails, keep workers running and try again on the next tick").
 * Other projects' refreshes are unaffected — one slow project does
 * not stall the rest.
 */
export async function reconcileTrackerStates(args: ReconcileArgs): Promise<void> {
  const { state, projects, logger, onTerminate } = args;
  if (state.running.size === 0) return;

  // Group running issue IDs by projectKey.
  const idsByProject = new Map<ProjectKey, IssueId[]>();
  for (const [id, entry] of state.running) {
    const key = entry.issue.projectKey;
    const list = idsByProject.get(key);
    if (list === undefined) idsByProject.set(key, [id]);
    else list.push(id);
  }

  // Fetch per project in parallel; per-project failure is local.
  await Promise.all(
    [...idsByProject.entries()].map(async ([projectKey, ids]) => {
      const ctx = projects.get(projectKey);
      if (ctx === undefined) {
        logger.warn('reconcile: running issue references unknown project; skipping', {
          project_key: projectKey,
          running_count: ids.length,
        });
        return;
      }

      const result = await ctx.tracker.fetchIssueStatesByIds({ ids });
      if (!result.ok) {
        logger.warn('tracker state refresh failed; keeping workers for project', {
          project_key: projectKey,
          error_code: result.error.code,
        });
        return;
      }

      for (const rawIssue of result.value) {
        // Re-stamp projectKey on the refreshed issue so the
        // running-entry update preserves multi-project metadata.
        const issue = { ...rawIssue, projectKey: ctx.key };
        if (isStateAmong(issue.state, ctx.terminalStates)) {
          logger.info('tracker reports terminal; terminating run', {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            project_key: ctx.key,
            state: issue.state,
          });
          onTerminate(issue.id, { cleanupWorkspace: true });
          continue;
        }
        if (isStateAmong(issue.state, ctx.activeStates)) {
          const entry = state.running.get(issue.id);
          if (entry !== undefined) {
            entry.issue = issue;
          }
          continue;
        }
        logger.info('tracker reports non-active state; terminating without workspace cleanup', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          project_key: ctx.key,
          state: issue.state,
        });
        onTerminate(issue.id, { cleanupWorkspace: false });
      }
    }),
  );
}
