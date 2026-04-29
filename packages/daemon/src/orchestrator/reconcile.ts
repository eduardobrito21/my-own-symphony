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

import type { ServiceConfig } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';
import { isStateAmong } from '../tracker/state-matching.js';
import type { Tracker } from '../tracker/tracker.js';
import type { IssueId } from '../types/index.js';

import type { MutableOrchestratorState } from './state.js';

export interface ReconcileArgs {
  readonly state: MutableOrchestratorState;
  readonly tracker: Tracker;
  readonly config: ServiceConfig;
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
 * `stall_timeout_ms <= 0`.
 */
export function reconcileStalledRuns(args: ReconcileArgs): void {
  const { state, config, logger, onStall } = args;
  const stallTimeoutMs = config.agent.stall_timeout_ms;
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
 * On fetch failure we keep all current workers running and try again
 * next tick (SPEC §8.5: "If state refresh fails, keep workers
 * running and try again on the next tick").
 */
export async function reconcileTrackerStates(args: ReconcileArgs): Promise<void> {
  const { state, tracker, config, logger, onTerminate } = args;
  const runningIds = [...state.running.keys()];
  if (runningIds.length === 0) return;

  const result = await tracker.fetchIssueStatesByIds({ ids: runningIds });
  if (!result.ok) {
    logger.warn('tracker state refresh failed; keeping workers', {
      error_code: result.error.code,
    });
    return;
  }

  for (const issue of result.value) {
    if (isStateAmong(issue.state, config.tracker.terminal_states)) {
      logger.info('tracker reports terminal; terminating run', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        state: issue.state,
      });
      onTerminate(issue.id, { cleanupWorkspace: true });
      continue;
    }
    if (isStateAmong(issue.state, config.tracker.active_states)) {
      // Active state — update the in-memory snapshot so logs and
      // the snapshot endpoint reflect the current state. Mutating
      // through the typed `running` map is allowed here because
      // we hold the orchestrator's lock.
      const entry = state.running.get(issue.id);
      if (entry !== undefined) {
        entry.issue = issue;
      }
      continue;
    }
    // Neither active nor terminal — paused / on-hold / a custom
    // workflow state. SPEC §8.5: terminate without cleanup so the
    // workspace is preserved if the issue returns to active later.
    logger.info('tracker reports non-active state; terminating without workspace cleanup', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      state: issue.state,
    });
    onTerminate(issue.id, { cleanupWorkspace: false });
  }
}
