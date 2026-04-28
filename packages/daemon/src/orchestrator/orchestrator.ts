// `Orchestrator` — the single-authority coordination class.
//
// Plan 04 scope (per the exec plan's "Out of scope" list):
//   IN  poll loop, dispatch, eligibility, mock agent runs, snapshot
//   OUT retries with backoff (Plan 05)
//   OUT reconciliation against tracker state changes (Plan 05)
//   OUT stall detection (Plan 05)
//   OUT dynamic workflow reload (Plan 05)
//
// Lifecycle:
//   start()  — schedules an immediate tick, returns
//   stop()   — clears the timer, awaits in-flight workers, returns
//   tick()   — public for testing; called internally by the scheduler
//   snapshot() — read-only point-in-time view of state
//
// All state mutations are serialized through `lock.run(...)`. Workers
// spawn asynchronously and report back through the lock — see
// `dispatchOne()` and `runWorker()`.

import type { ServiceConfig } from '../config/schema.js';
import { parsePromptTemplate, renderPrompt } from '../agent/prompt.js';
import type { AgentEvent, AgentRunner } from '../agent/runner.js';
import type { Logger } from '../observability/index.js';
import { sortForDispatch } from '../tracker/sort.js';
import type { Tracker } from '../tracker/tracker.js';
import {
  composeSessionId,
  type Issue,
  type IssueId,
  type OrchestratorState,
  type SessionId,
} from '../types/index.js';
import type { WorkspaceManager } from '../workspace/index.js';

import { evaluateRuntimeEligibility } from './eligibility.js';
import { AsyncLock } from './lock.js';
import {
  createInitialState,
  newRunningEntry,
  snapshotState,
  type MutableOrchestratorState,
  type MutableRunningEntry,
} from './state.js';

export interface OrchestratorArgs {
  readonly config: ServiceConfig;
  readonly promptTemplateSource: string;
  readonly tracker: Tracker;
  readonly workspaceManager: WorkspaceManager;
  readonly agent: AgentRunner;
  readonly logger: Logger;
  /** Override the timer mechanism for tests. */
  readonly schedule?: TimerSchedule;
  /** Override the clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface TimerSchedule {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_SCHEDULE: TimerSchedule = {
  setTimeout: (h, ms) => globalThis.setTimeout(h, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};

export class Orchestrator {
  private readonly state: MutableOrchestratorState;
  private readonly lock = new AsyncLock();
  private readonly tracker: Tracker;
  private readonly workspaceManager: WorkspaceManager;
  private readonly agent: AgentRunner;
  private readonly logger: Logger;
  private readonly config: ServiceConfig;
  private readonly schedule: TimerSchedule;
  private readonly now: () => Date;
  private readonly parsedTemplate: ReturnType<typeof parsePromptTemplate>;

  /** In-flight workers, keyed by issue id. Resolves when the worker exits. */
  private readonly workers = new Map<IssueId, Promise<void>>();
  /** Per-worker abort controllers so we can cancel agent runs on shutdown. */
  private readonly workerAborts = new Map<IssueId, AbortController>();

  private tickHandle: unknown = null;
  private stopped = false;

  constructor(args: OrchestratorArgs) {
    this.tracker = args.tracker;
    this.workspaceManager = args.workspaceManager;
    this.agent = args.agent;
    this.logger = args.logger;
    this.config = args.config;
    this.schedule = args.schedule ?? DEFAULT_SCHEDULE;
    this.now = args.now ?? (() => new Date());
    this.state = createInitialState({
      pollIntervalMs: args.config.polling.interval_ms,
      maxConcurrentAgents: args.config.agent.max_concurrent_agents,
    });
    this.parsedTemplate = parsePromptTemplate(args.promptTemplateSource);
  }

  // ---- Lifecycle ------------------------------------------------------

  start(): void {
    if (this.stopped) {
      throw new Error('Orchestrator is stopped; construct a new instance.');
    }
    this.logger.info('orchestrator started', {
      poll_interval_ms: this.state.pollIntervalMs,
      max_concurrent_agents: this.state.maxConcurrentAgents,
    });
    this.scheduleNextTick(0);
  }

  /**
   * Forceful stop: cancel the tick timer, abort every in-flight
   * agent, wait for every worker to settle. SIGINT / SIGTERM
   * handlers in the composition root use this.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info('orchestrator stopping');
    if (this.tickHandle !== null) {
      this.schedule.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    for (const ac of this.workerAborts.values()) {
      ac.abort();
    }
    await Promise.allSettled(this.workers.values());
    this.logger.info('orchestrator stopped', {
      completed_count: this.state.completed.size,
    });
  }

  /**
   * Wait for every currently running worker to finish naturally
   * without aborting them. Tests use this between `tick()` and
   * assertions to let the in-flight agent complete cleanly.
   * Does NOT cancel the tick timer.
   */
  async drain(): Promise<void> {
    await Promise.allSettled(this.workers.values());
  }

  // ---- Snapshot --------------------------------------------------------

  snapshot(): OrchestratorState {
    return snapshotState(this.state);
  }

  // ---- Tick ------------------------------------------------------------

  /**
   * Public for tests. The internal scheduler calls this on each timer
   * fire. Always returns after one full tick (dispatch decisions made,
   * workers spawned). Workers may continue executing after `tick()`
   * resolves.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.lock.run(() => this.runTick());
  }

  private async runTick(): Promise<void> {
    this.logger.info('tick start', { running: this.state.running.size });

    const fetched = await this.tracker.fetchCandidateIssues({
      activeStates: this.config.tracker.active_states,
    });
    if (!fetched.ok) {
      this.logger.warn('tracker fetch failed; skipping dispatch this tick', {
        error_code: fetched.error.code,
      });
      return;
    }

    const candidates = sortForDispatch(fetched.value);
    let dispatched = 0;
    for (const issue of candidates) {
      const eligibility = evaluateRuntimeEligibility(issue, {
        state: this.state,
        tracker: this.config.tracker,
        agent: this.config.agent,
      });
      if (!eligibility.eligible) {
        this.logger.info('skip', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          reason: eligibility.reason,
        });
        continue;
      }
      this.dispatchOne(issue, null);
      dispatched += 1;
    }

    this.logger.info('tick end', {
      candidates: candidates.length,
      dispatched,
      running: this.state.running.size,
    });
  }

  private scheduleNextTick(ms: number): void {
    if (this.stopped) return;
    this.tickHandle = this.schedule.setTimeout(() => {
      this.tickHandle = null;
      void this.tickAndReschedule();
    }, ms);
  }

  private async tickAndReschedule(): Promise<void> {
    try {
      await this.tick();
    } catch (cause) {
      this.logger.error('tick threw — continuing scheduler', { cause });
    } finally {
      if (!this.stopped) {
        this.scheduleNextTick(this.state.pollIntervalMs);
      }
    }
  }

  // ---- Dispatch / worker lifecycle -------------------------------------

  /**
   * Launch a worker for `issue`. Adds an entry to `running` and
   * `claimed` synchronously (we already hold the lock); spawns the
   * actual work asynchronously.
   */
  private dispatchOne(issue: Issue, retryAttempt: number | null): void {
    const placeholderSessionId = composeSessionId('pending', issue.id);
    const entry = newRunningEntry({
      issue,
      retryAttempt,
      placeholderSessionId,
      now: this.now(),
    });
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);

    const ac = new AbortController();
    this.workerAborts.set(issue.id, ac);

    const issueLogger = this.logger.with({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    issueLogger.info('dispatch', { retry_attempt: retryAttempt });

    // Run the worker in the background. We capture the promise so
    // `stop()` can await all in-flight workers; we also attach a
    // catch so an uncaught rejection from the worker doesn't leak.
    const work = this.runWorker(issue, ac.signal, issueLogger).catch((cause: unknown) => {
      issueLogger.error('worker promise rejected (this is a bug)', { cause });
    });
    this.workers.set(issue.id, work);
  }

  private async runWorker(issue: Issue, signal: AbortSignal, log: Logger): Promise<void> {
    let exitReason: 'normal' | 'abnormal' = 'normal';
    let exitError: string | null = null;

    const startedAt = this.now();

    try {
      const workspaceResult = await this.workspaceManager.prepareForRun(issue.identifier);
      if (!workspaceResult.ok) {
        exitReason = 'abnormal';
        exitError = `workspace_${workspaceResult.error.code}`;
        log.error('workspace preparation failed', { error_code: workspaceResult.error.code });
        return;
      }
      const workspace = workspaceResult.workspace;

      if (!this.parsedTemplate.ok) {
        exitReason = 'abnormal';
        exitError = `prompt_${this.parsedTemplate.error.code}`;
        log.error('workflow template did not parse', {
          error_code: this.parsedTemplate.error.code,
        });
        await this.workspaceManager.finalizeAfterRun(workspace);
        return;
      }

      const renderResult = await renderPrompt(this.parsedTemplate.template, {
        issue,
        attempt: null,
      });
      if (!renderResult.ok) {
        exitReason = 'abnormal';
        exitError = `prompt_${renderResult.code}`;
        log.error('prompt render failed', { error_code: renderResult.code });
        await this.workspaceManager.finalizeAfterRun(workspace);
        return;
      }

      try {
        const events = this.agent.run({
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          workspacePath: workspace.path,
          prompt: renderResult.value,
          attempt: null,
          signal,
        });
        for await (const event of events) {
          await this.applyAgentEvent(issue.id, event, log);
        }
      } catch (cause) {
        exitReason = 'abnormal';
        exitError = stringifyCause(cause);
        log.error('agent run threw', { cause });
      }

      await this.workspaceManager.finalizeAfterRun(workspace);
    } finally {
      const finishedAt = this.now();
      const durationSec = (finishedAt.getTime() - startedAt.getTime()) / 1000;
      await this.lock.run(() => {
        this.completeWorker(issue.id, durationSec, exitReason, exitError, log);
      });
    }
  }

  /**
   * Apply one agent event to the corresponding running entry. Holds
   * the lock for the duration of the mutation.
   */
  private async applyAgentEvent(id: IssueId, event: AgentEvent, log: Logger): Promise<void> {
    await this.lock.run(() => {
      const entry = this.state.running.get(id);
      if (entry === undefined) return;
      updateLiveSession(entry, event);
      log.info('agent_event', {
        kind: event.kind,
        ...(event.kind === 'session_started' && { session_id: event.sessionId }),
        ...(event.kind === 'notification' && { message: event.message }),
        ...(event.kind === 'turn_failed' && { reason: event.reason }),
      });
    });
  }

  private completeWorker(
    id: IssueId,
    durationSec: number,
    reason: 'normal' | 'abnormal',
    error: string | null,
    log: Logger,
  ): void {
    const entry = this.state.running.get(id);
    this.state.running.delete(id);
    this.workers.delete(id);
    this.workerAborts.delete(id);
    this.state.agentTotals.secondsRunning += durationSec;

    if (reason === 'normal') {
      this.state.completed.add(id);
      // Plan 04 leaves the issue claimed; Plan 05 will release the
      // claim or schedule a continuation retry. For now, we drop the
      // claim so the next tick can pick it up again if the tracker
      // still reports it as active.
      this.state.claimed.delete(id);
    } else {
      // Plan 05 will schedule a backoff retry here. For Plan 04 we
      // simply drop the claim so the next tick can re-dispatch (and
      // we log the failure so it's visible).
      this.state.claimed.delete(id);
    }

    log.info('worker_exit', {
      reason,
      duration_sec: durationSec.toFixed(3),
      ...(error !== null && { error }),
      ...(entry !== undefined && { session_id: entry.session.sessionId }),
    });
  }
}

// ---------------------------------------------------------------------
// Helpers below this line operate on `MutableLiveSession` directly.

function updateLiveSession(entry: MutableRunningEntry, event: AgentEvent): void {
  const session = entry.session;
  session.lastAgentEvent = event.kind;
  session.lastAgentTimestamp = event.at;

  switch (event.kind) {
    case 'session_started':
      session.sessionId = event.sessionId;
      session.threadId = event.threadId;
      session.turnId = event.turnId;
      break;
    case 'notification':
      session.lastAgentMessage = event.message;
      break;
    case 'turn_completed':
      session.turnCount = event.turnNumber;
      break;
    case 'turn_failed':
      session.lastAgentMessage = event.reason;
      break;
  }
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

export type { MutableOrchestratorState, SessionId };
