// `Orchestrator` — the single-authority coordination class.
//
// Plan 04 added: poll loop, dispatch, eligibility, mock agent runs,
//                snapshot.
// Plan 05 adds:  retry queue with backoff, reconciliation (stall +
//                tracker state), dynamic `WORKFLOW.md` reload.
//
// All state mutations are serialized through `lock.run(...)`. Workers
// spawn asynchronously and report back through the lock.

import { parsePromptTemplate, renderPrompt } from '../agent/prompt.js';
import type { AgentEvent, AgentRunner } from '../agent/runner.js';
import type { ServiceConfig, WorkflowDefinition } from '../config/schema.js';
import type { Logger } from '../observability/index.js';
import { sortForDispatch } from '../tracker/sort.js';
import {
  composeSessionId,
  type Issue,
  type IssueId,
  type IssueIdentifier,
  type OrchestratorState,
  type ProjectKey,
} from '../types/index.js';
import type { WorkspaceManager } from '../workspace/index.js';

import { evaluateRuntimeEligibility } from './eligibility.js';
import { AsyncLock } from './lock.js';
import type { ProjectContextMap } from './project.js';
import { reconcile } from './reconcile.js';
import { cancelRetry, scheduleRetry } from './retry.js';
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
  /**
   * Multi-project (Plan 09c). One context per Linear project the
   * daemon is watching. The orchestrator iterates this map per
   * tick to fetch candidates from each project's tracker. For
   * single-project deployments (legacy WORKFLOW.md, current tests),
   * pass a one-entry map via `singleProjectContext(...)`.
   */
  readonly projects: ProjectContextMap;
  readonly workspaceManager: WorkspaceManager;
  readonly agent: AgentRunner;
  readonly logger: Logger;
  /** Override the timer mechanism for tests. */
  readonly schedule?: TimerSchedule;
  /** Override the wall clock for deterministic tests. */
  readonly now?: () => Date;
  /** Override the monotonic clock used for retry due times. */
  readonly monotonicNow?: () => number;
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
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

export class Orchestrator {
  private readonly state: MutableOrchestratorState;
  private readonly lock = new AsyncLock();
  private readonly projects: ProjectContextMap;
  private readonly workspaceManager: WorkspaceManager;
  private readonly agent: AgentRunner;
  private readonly logger: Logger;
  private readonly schedule: TimerSchedule;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;

  // Mutable so `applyWorkflow` (Plan 05 dynamic reload) can swap them.
  private config: ServiceConfig;
  private parsedTemplate: ReturnType<typeof parsePromptTemplate>;

  /** In-flight workers, keyed by issue id. Resolves when the worker exits. */
  private readonly workers = new Map<IssueId, Promise<void>>();
  /** Per-worker abort controllers so we can cancel agent runs. */
  private readonly workerAborts = new Map<IssueId, AbortController>();
  /**
   * Issues whose run was canceled by reconciliation. `completeWorker`
   * checks this set to skip retry scheduling for cancellations —
   * only stalls and "natural" abnormal exits should trigger retries.
   */
  private readonly canceled = new Set<IssueId>();

  private tickHandle: unknown = null;
  private stopped = false;

  constructor(args: OrchestratorArgs) {
    if (args.projects.size === 0) {
      throw new Error('Orchestrator requires at least one ProjectContext.');
    }
    this.projects = args.projects;
    this.workspaceManager = args.workspaceManager;
    this.agent = args.agent;
    this.logger = args.logger;
    this.config = args.config;
    this.schedule = args.schedule ?? DEFAULT_SCHEDULE;
    this.now = args.now ?? (() => new Date());
    this.monotonicNow = args.monotonicNow ?? (() => performance.now());
    this.state = createInitialState({
      pollIntervalMs: args.config.polling.interval_ms,
      maxConcurrentAgents: args.config.agent.max_concurrent_agents,
      projectKeys: [...args.projects.keys()],
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
   * Forceful stop: cancel timers, abort every in-flight agent, wait
   * for every worker to settle. SIGINT/SIGTERM in the composition
   * root use this.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info('orchestrator stopping');
    if (this.tickHandle !== null) {
      this.schedule.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    // Cancel every pending retry timer so it can't fire post-stop.
    for (const id of [...this.state.retryAttempts.keys()]) {
      cancelRetry(this.state, id, this.schedule);
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
   * Wait for every currently running worker to finish naturally.
   * Tests use this to assert post-tick state. Does NOT cancel timers.
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
   * Run one full tick. Public for tests.
   *
   * Sequence (SPEC §8.1):
   *   1. Reconcile running issues (stall + tracker state refresh).
   *   2. Fetch candidate issues.
   *   3. Sort and dispatch within concurrency limits.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.lock.run(() => this.runTick());
  }

  private async runTick(): Promise<void> {
    this.logger.info('tick start', {
      running: this.state.running.size,
      retrying: this.state.retryAttempts.size,
      projects: this.projects.size,
    });

    // Plan 05 + Plan 09c: reconciliation runs every tick, BEFORE
    // dispatch (per SPEC §8.1). Multi-project: fan out per-project
    // by splitting running issues by their stamped projectKey and
    // calling each project's tracker with that project's terminal/
    // active state vocabulary.
    await reconcile({
      state: this.state,
      projects: this.projects,
      stallTimeoutMs: this.config.agent.stall_timeout_ms,
      logger: this.logger,
      now: this.now,
      onTerminate: (id, opts) => {
        this.terminateRunning(id, opts);
      },
      onStall: (id) => {
        // Stall: just abort. The worker's abnormal exit will go
        // through completeWorker, which will schedule a normal
        // failure retry. We do NOT mark as canceled here.
        const ac = this.workerAborts.get(id);
        ac?.abort();
      },
    });

    // Per-project poll: gather candidates from each tracker,
    // stamping the project key onto every accumulated Issue.
    // Trackers don't know about multi-project; the orchestrator
    // owns the stamping (Plan 09c decision: keep tracker layer
    // ignorant of project membership).
    const allCandidates: Issue[] = [];
    for (const ctx of this.projects.values()) {
      const fetched = await ctx.tracker.fetchCandidateIssues({
        activeStates: ctx.activeStates,
      });
      if (!fetched.ok) {
        this.logger.warn('tracker fetch failed; skipping project this tick', {
          project_key: ctx.key,
          error_code: fetched.error.code,
        });
        continue;
      }
      for (const issue of fetched.value) {
        allCandidates.push({ ...issue, projectKey: ctx.key });
      }
    }

    const candidates = sortForDispatch(allCandidates);
    let dispatched = 0;
    for (const issue of candidates) {
      const ctx = this.projects.get(issue.projectKey);
      if (ctx === undefined) {
        // Should not happen — we just stamped projectKey from
        // ctx.key. Defensive log + skip.
        this.logger.warn('candidate has unknown projectKey; skipping', {
          issue_id: issue.id,
          project_key: issue.projectKey,
        });
        continue;
      }
      const eligibility = evaluateRuntimeEligibility(issue, {
        state: this.state,
        activeStates: ctx.activeStates,
        terminalStates: ctx.terminalStates,
        agent: this.config.agent,
      });
      if (!eligibility.eligible) {
        this.logger.info('skip', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          project_key: issue.projectKey,
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

  // ---- Dynamic reload --------------------------------------------------

  /**
   * Apply a freshly-loaded `WorkflowDefinition`. Called by the file
   * watcher (Plan 05) when `WORKFLOW.md` changes. SPEC §6.2:
   *   - re-apply config and prompt template without restart
   *   - apply to FUTURE dispatch decisions; in-flight runs keep
   *     their original values
   *   - poll interval / concurrency change is reflected on the next
   *     tick
   */
  async applyWorkflow(def: WorkflowDefinition): Promise<void> {
    await this.lock.run(() => {
      const prevPollMs = this.state.pollIntervalMs;
      this.config = def.config;
      this.parsedTemplate = parsePromptTemplate(def.promptTemplate);
      this.state.pollIntervalMs = def.config.polling.interval_ms;
      this.state.maxConcurrentAgents = def.config.agent.max_concurrent_agents;
      this.workspaceManager.setHooks(def.config.hooks);

      this.logger.info('workflow reloaded', {
        poll_interval_ms: this.state.pollIntervalMs,
        max_concurrent_agents: this.state.maxConcurrentAgents,
        prompt_parsed: this.parsedTemplate.ok,
      });

      // If the poll interval changed and we have a tick scheduled,
      // reschedule with the new interval so changes apply faster.
      if (this.tickHandle !== null && this.state.pollIntervalMs !== prevPollMs && !this.stopped) {
        this.schedule.clearTimeout(this.tickHandle);
        this.tickHandle = null;
        this.scheduleNextTick(this.state.pollIntervalMs);
      }
    });
  }

  // ---- Dispatch / worker lifecycle -------------------------------------

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
    // If the issue was sitting in the retry queue, we're picking it
    // up now — drop the queued entry so it doesn't double-fire.
    cancelRetry(this.state, issue.id, this.schedule);

    const ac = new AbortController();
    this.workerAborts.set(issue.id, ac);

    const issueLogger = this.logger.with({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    issueLogger.info('dispatch', { retry_attempt: retryAttempt });

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
      const workspaceResult = await this.workspaceManager.prepareForRun(
        issue.identifier,
        issue.projectKey,
      );
      if (!workspaceResult.ok) {
        exitReason = 'abnormal';
        exitError = `workspace_${workspaceResult.error.code}`;
        log.error('workspace preparation failed', {
          error_code: workspaceResult.error.code,
        });
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

      // Track terminal events emitted by the agent. SPEC contract:
      // exactly one terminal event per run (`turn_completed` or
      // `turn_failed`). We treat a `turn_failed` as an abnormal exit
      // even if the iterable completes normally — otherwise an agent
      // that yields `turn_failed` and returns gets the same retry
      // treatment as a clean success, which produces a tight retry
      // loop on persistent failures (Bug 1, Plan 07 smoke run
      // 2026-04-29).
      let lastTerminal: 'turn_completed' | 'turn_failed' | null = null;
      let turnFailedReason: string | null = null;
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
          if (event.kind === 'turn_completed') {
            lastTerminal = 'turn_completed';
          } else if (event.kind === 'turn_failed') {
            lastTerminal = 'turn_failed';
            turnFailedReason = event.reason;
          }
        }
      } catch (cause) {
        exitReason = 'abnormal';
        exitError = stringifyCause(cause);
        log.error('agent run threw', { cause });
      }

      if (exitReason === 'normal' && lastTerminal === 'turn_failed') {
        exitReason = 'abnormal';
        exitError = `turn_failed: ${turnFailedReason ?? 'unknown'}`;
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

  private async applyAgentEvent(id: IssueId, event: AgentEvent, log: Logger): Promise<void> {
    await this.lock.run(() => {
      const entry = this.state.running.get(id);
      if (entry === undefined) return;
      updateLiveSession(entry, event);
      // Per-turn usage events fold into the daemon-wide totals here,
      // inside the lock, so concurrent agents can't race on the
      // accumulator. Plan 07 / SDK reports per-turn (NOT cumulative)
      // numbers, so we add directly without diffing — see decision
      // log entry "Per-turn token semantics".
      if (event.kind === 'usage') {
        this.state.agentTotals.inputTokens += event.inputTokens;
        this.state.agentTotals.outputTokens += event.outputTokens;
        this.state.agentTotals.totalTokens += event.inputTokens + event.outputTokens;
      }
      log.info('agent_event', {
        kind: event.kind,
        ...(event.kind === 'session_started' && { session_id: event.sessionId }),
        ...(event.kind === 'notification' && { message: event.message }),
        ...(event.kind === 'tool_call' && {
          tool_name: event.toolName,
          call_id: event.callId,
        }),
        ...(event.kind === 'tool_result' && {
          call_id: event.callId,
          is_error: event.isError,
        }),
        ...(event.kind === 'usage' && {
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          cache_creation_input_tokens: event.cacheCreationInputTokens,
          cache_read_input_tokens: event.cacheReadInputTokens,
          total_cost_usd: event.totalCostUsd,
        }),
        ...(event.kind === 'turn_failed' && { reason: event.reason }),
      });
    });
  }

  /**
   * Worker exit handler. SPEC §16.6 dictates the retry policy:
   *   - normal exit       -> add to `completed`, schedule continuation retry
   *   - abnormal exit     -> schedule failure-driven retry
   *   - canceled (us)     -> no retry; just bookkeeping
   *   - shutdown          -> no retry; bookkeeping only
   */
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

    const wasCanceled = this.canceled.delete(id);

    if (this.stopped || wasCanceled) {
      // No retry: bookkeeping only.
      this.state.claimed.delete(id);
      log.info('worker_exit', {
        reason,
        duration_sec: durationSec.toFixed(3),
        retried: false,
        canceled: wasCanceled,
        ...(error !== null && { error }),
        ...(entry !== undefined && { session_id: entry.session.sessionId }),
      });
      return;
    }

    const identifier = entry?.issue.identifier ?? ('unknown' as IssueIdentifier);
    // Project key for the retry. If the worker entry is gone (it
    // shouldn't be — the worker just exited), fall back to the
    // first project's key to keep the snapshot's per-project
    // counter semi-meaningful.
    const projectKey = entry?.issue.projectKey ?? this.firstProjectKey();
    if (reason === 'normal') {
      this.state.completed.add(id);
      const delayMs = scheduleRetry({
        state: this.state,
        issueId: id,
        identifier,
        projectKey,
        ...(entry?.issue !== undefined && { issue: entry.issue }),
        attempt: 1,
        delayKind: 'continuation',
        maxRetryBackoffMs: this.config.agent.max_retry_backoff_ms,
        schedule: this.schedule,
        onFire: (retryId) => {
          void this.handleRetryFire(retryId);
        },
        monotonicNow: this.monotonicNow,
      });
      log.info('worker_exit', {
        reason,
        duration_sec: durationSec.toFixed(3),
        retried: true,
        retry_kind: 'continuation',
        retry_delay_ms: delayMs,
        ...(entry !== undefined && { session_id: entry.session.sessionId }),
      });
    } else {
      // Failure-driven retry. The first attempt is 1 (so backoff
      // starts at 10s). If we're already in the retry queue from a
      // previous failure, increment off that.
      const prevAttempt = entry?.retryAttempt ?? 0;
      const nextAttempt = prevAttempt + 1;
      const minDelayMs = isRateLimitError(error) ? RATE_LIMIT_RETRY_DELAY_MS : undefined;
      const delayMs = scheduleRetry({
        state: this.state,
        issueId: id,
        identifier,
        projectKey,
        ...(entry?.issue !== undefined && { issue: entry.issue }),
        attempt: nextAttempt,
        delayKind: 'failure',
        maxRetryBackoffMs: this.config.agent.max_retry_backoff_ms,
        ...(minDelayMs !== undefined && { minDelayMs }),
        schedule: this.schedule,
        onFire: (retryId) => {
          void this.handleRetryFire(retryId);
        },
        // Only set `error` when present — exactOptionalPropertyTypes
        // forbids passing `undefined` to an optional field.
        ...(error !== null && { error }),
        monotonicNow: this.monotonicNow,
      });
      log.info('worker_exit', {
        reason,
        duration_sec: durationSec.toFixed(3),
        retried: true,
        retry_kind: 'failure',
        retry_attempt: nextAttempt,
        retry_delay_ms: delayMs,
        ...(error !== null && { error }),
        ...(entry !== undefined && { session_id: entry.session.sessionId }),
      });
    }
  }

  /**
   * Reconciliation-driven termination. Aborts the worker; sets the
   * `canceled` flag so `completeWorker` skips retry scheduling.
   * If `cleanupWorkspace` is true, schedules workspace removal
   * (fire-and-forget).
   */
  private terminateRunning(id: IssueId, opts: { readonly cleanupWorkspace: boolean }): void {
    const entry = this.state.running.get(id);
    if (entry === undefined) return;
    this.canceled.add(id);
    const ac = this.workerAborts.get(id);
    ac?.abort();
    cancelRetry(this.state, id, this.schedule);
    if (opts.cleanupWorkspace) {
      const identifier = entry.issue.identifier;
      const projectKey = entry.issue.projectKey;
      void this.workspaceManager.removeForTerminal(identifier, projectKey);
    }
    // We do not remove from `running` here — `completeWorker` does
    // that in its `finally` after the worker promise settles. The
    // canceled flag ensures no retry is scheduled at that point.
  }

  // ---- Retry timer firing ----------------------------------------------

  /**
   * Called when a retry timer fires. Implements SPEC §16.6
   * onRetryTimer: drop the retry entry; re-fetch candidates; if
   * the issue still exists and is dispatch-eligible, dispatch; if
   * no slots, requeue with attempt + 1; else release the claim.
   */
  private async handleRetryFire(id: IssueId): Promise<void> {
    if (this.stopped) return;
    await this.lock.run(async () => {
      const entry = this.state.retryAttempts.get(id);
      if (entry === undefined) return;
      this.state.retryAttempts.delete(id);
      this.state.claimed.delete(id);

      const log = this.logger.with({
        issue_id: id,
        issue_identifier: entry.identifier,
        project_key: entry.projectKey,
      });
      log.info('retry_fired', { attempt: entry.attempt });

      const ctx = this.projects.get(entry.projectKey);
      if (ctx === undefined) {
        // The project this retry belongs to is no longer in the
        // deployment config (operator removed it between schedule
        // and fire). Release the claim and drop the retry; we do
        // not query a removed project.
        this.state.claimed.delete(id);
        log.warn('retry_released_claim', { reason: 'project_removed' });
        return;
      }

      const candidates = await ctx.tracker.fetchCandidateIssues({
        activeStates: ctx.activeStates,
      });
      if (!candidates.ok) {
        const delayMs = scheduleRetry({
          state: this.state,
          issueId: id,
          identifier: entry.identifier,
          projectKey: entry.projectKey,
          ...(entry.issue !== undefined && { issue: entry.issue }),
          attempt: entry.attempt + 1,
          delayKind: 'failure',
          maxRetryBackoffMs: this.config.agent.max_retry_backoff_ms,
          schedule: this.schedule,
          onFire: (retryId) => {
            void this.handleRetryFire(retryId);
          },
          error: 'retry poll failed',
          monotonicNow: this.monotonicNow,
        });
        log.warn('retry_requeued', {
          reason: 'tracker_fetch_failed',
          attempt: entry.attempt + 1,
          delay_ms: delayMs,
        });
        return;
      }

      const rawIssue = candidates.value.find((i) => i.id === id);
      if (rawIssue === undefined) {
        this.state.claimed.delete(id);
        log.info('retry_released_claim', { reason: 'not_in_active_states' });
        return;
      }
      // Stamp the projectKey before downstream use (the tracker
      // doesn't populate it).
      const issue: Issue = { ...rawIssue, projectKey: entry.projectKey };

      const eligibility = evaluateRuntimeEligibility(issue, {
        state: this.state,
        activeStates: ctx.activeStates,
        terminalStates: ctx.terminalStates,
        agent: this.config.agent,
      });
      if (eligibility.eligible) {
        this.dispatchOne(issue, entry.attempt);
        return;
      }

      if (eligibility.reason === 'no_global_slot' || eligibility.reason === 'no_per_state_slot') {
        const delayMs = scheduleRetry({
          state: this.state,
          issueId: id,
          identifier: issue.identifier,
          projectKey: entry.projectKey,
          issue,
          attempt: entry.attempt + 1,
          delayKind: 'failure',
          maxRetryBackoffMs: this.config.agent.max_retry_backoff_ms,
          schedule: this.schedule,
          onFire: (retryId) => {
            void this.handleRetryFire(retryId);
          },
          error: 'no available orchestrator slots',
          monotonicNow: this.monotonicNow,
        });
        log.info('retry_requeued', {
          reason: eligibility.reason,
          attempt: entry.attempt + 1,
          delay_ms: delayMs,
        });
        return;
      }

      this.state.claimed.delete(id);
      log.info('retry_released_claim', { reason: eligibility.reason });
    });
  }

  /** First project key in deployment order. Used as a fallback when
   *  the orchestrator needs a projectKey but the issue is missing
   *  (defensive — entries should always carry one). */
  private firstProjectKey(): ProjectKey {
    const first = this.projects.keys().next().value;
    if (first === undefined) {
      throw new Error('Orchestrator has no projects (constructor invariant violated).');
    }
    return first;
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
    case 'tool_call':
      // Surface the tool name as the latest "what is the agent
      // doing right now" string. The dashboard reads this to
      // distinguish "thinking" from "calling Linear".
      session.lastAgentMessage = `calling ${event.toolName}`;
      break;
    case 'tool_result':
      session.lastAgentMessage = event.isError
        ? `tool error (call ${event.callId})`
        : `tool returned (call ${event.callId})`;
      break;
    case 'usage':
      // Per-turn usage from the SDK. Add to the live session's
      // running totals so a snapshot reflects the cost of work in
      // flight. Daemon-wide accumulation happens in
      // `applyAgentEvent`. The `lastReported*` fields stay zero —
      // we don't need diff math here because the SDK reports
      // per-turn rather than cumulative-since-thread-start.
      session.tokens.inputTokens += event.inputTokens;
      session.tokens.outputTokens += event.outputTokens;
      session.tokens.totalTokens += event.inputTokens + event.outputTokens;
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

function isRateLimitError(error: string | null): boolean {
  if (error === null) return false;
  const lower = error.toLowerCase();
  return lower.includes('rate limit') || lower.includes('request rejected (429)');
}
