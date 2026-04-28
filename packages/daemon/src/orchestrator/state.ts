// Mutable orchestrator state and helpers for snapshotting it.
//
// SPEC §4.1.8 defines the read-only shape (`OrchestratorState` in
// `types/orchestrator-state.ts`). This file owns the *writable*
// interior used internally by the orchestrator — separated to keep
// "external readers see read-only" honest at the type level.
//
// Per ADR 0008, the spec's `codex_*` field names are renamed to
// `agent_*` here. SPEC §13.5 token-accounting rules are preserved
// verbatim (we track `lastReported*` to dedupe absolute totals).

import type {
  AgentTotals,
  Issue,
  IssueId,
  LiveSession,
  OrchestratorState,
  RetryEntry,
  RunningEntry,
  SessionId,
} from '../types/index.js';

/** Mutable interior. The orchestrator class owns the only mutable reference. */
export interface MutableOrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<IssueId, MutableRunningEntry>;
  claimed: Set<IssueId>;
  retryAttempts: Map<IssueId, RetryEntry>;
  completed: Set<IssueId>;
  agentTotals: MutableAgentTotals;
  agentRateLimits: unknown;
}

export interface MutableRunningEntry {
  issue: Issue;
  session: MutableLiveSession;
  startedAt: Date;
  retryAttempt: number | null;
}

export interface MutableLiveSession {
  sessionId: SessionId;
  threadId: string;
  turnId: string;
  agentRuntimePid: string | null;
  lastAgentEvent: string | null;
  lastAgentTimestamp: Date | null;
  lastAgentMessage: string | null;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    lastReportedInputTokens: number;
    lastReportedOutputTokens: number;
    lastReportedTotalTokens: number;
  };
  turnCount: number;
}

export interface MutableAgentTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export function createInitialState(args: {
  readonly pollIntervalMs: number;
  readonly maxConcurrentAgents: number;
}): MutableOrchestratorState {
  return {
    pollIntervalMs: args.pollIntervalMs,
    maxConcurrentAgents: args.maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    agentTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    agentRateLimits: null,
  };
}

/**
 * Build the initial running entry for a freshly dispatched issue.
 * The session ID is provisional — it gets overwritten by the
 * `session_started` event from the agent.
 */
export function newRunningEntry(args: {
  readonly issue: Issue;
  readonly retryAttempt: number | null;
  readonly placeholderSessionId: SessionId;
  readonly now: Date;
}): MutableRunningEntry {
  return {
    issue: args.issue,
    startedAt: args.now,
    retryAttempt: args.retryAttempt,
    session: {
      sessionId: args.placeholderSessionId,
      threadId: '',
      turnId: '',
      agentRuntimePid: null,
      lastAgentEvent: null,
      lastAgentTimestamp: null,
      lastAgentMessage: null,
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastReportedInputTokens: 0,
        lastReportedOutputTokens: 0,
        lastReportedTotalTokens: 0,
      },
      turnCount: 0,
    },
  };
}

/**
 * Project the mutable interior into the read-only `OrchestratorState`
 * shape that consumers (HTTP API, dashboard, observability) see.
 *
 * We do a shallow copy of the maps/sets so that subsequent mutations
 * to the live state don't leak through old snapshots. Inner objects
 * are not deep-cloned — they're treated as point-in-time references.
 */
export function snapshotState(state: MutableOrchestratorState): OrchestratorState {
  return {
    pollIntervalMs: state.pollIntervalMs,
    maxConcurrentAgents: state.maxConcurrentAgents,
    running: new Map(
      Array.from(state.running, ([id, entry]) => [id, toReadonlyRunningEntry(entry)]),
    ),
    claimed: new Set(state.claimed),
    retryAttempts: new Map(state.retryAttempts),
    completed: new Set(state.completed),
    agentTotals: { ...state.agentTotals } satisfies AgentTotals,
    agentRateLimits: state.agentRateLimits,
  };
}

function toReadonlyRunningEntry(entry: MutableRunningEntry): RunningEntry {
  return {
    issue: entry.issue,
    startedAt: entry.startedAt,
    retryAttempt: entry.retryAttempt,
    session: toReadonlyLiveSession(entry.session),
  };
}

function toReadonlyLiveSession(session: MutableLiveSession): LiveSession {
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    turnId: session.turnId,
    agentRuntimePid: session.agentRuntimePid,
    lastAgentEvent: session.lastAgentEvent,
    lastAgentTimestamp: session.lastAgentTimestamp,
    lastAgentMessage: session.lastAgentMessage,
    tokens: { ...session.tokens },
    turnCount: session.turnCount,
  };
}
