// Serialize an `OrchestratorState` into a JSON-safe shape for the
// HTTP `/api/v1/state` endpoint and (eventually) the dashboard.
//
// `OrchestratorState` carries `Map`s, `Set`s, and `Date`s — none of
// which `JSON.stringify` handles correctly without a replacer:
//   - Map and Set serialize as `{}` / `{}` by default (silent data
//     loss),
//   - Date serializes via its `toJSON` (ISO string) which is fine,
//     but only at the leaves; nested deep inside a Map's value it's
//     never reached because the Map is gone first.
//
// Rather than a JSON replacer (which is opaque to TypeScript), we
// define a wire shape and a conversion function. The wire shape is
// what the dashboard's TypeScript types should mirror.

import type {
  AgentTotals,
  Issue,
  LiveSession,
  OrchestratorState,
  RetryEntry,
} from '../types/index.js';

// ---- Wire shapes ----------------------------------------------------

/**
 * One issue currently being worked on. Wire-friendly: Dates → ISO
 * strings, Maps/Sets unrolled, branded ids → plain strings.
 */
export interface RunningEntryWire {
  readonly id: string;
  readonly issue: IssueWire;
  readonly session: LiveSessionWire;
  /** ISO-8601 of when the orchestrator dispatched this run. */
  readonly startedAt: string;
  readonly retryAttempt: number | null;
}

export interface IssueWire {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number | null;
  readonly state: string;
  readonly branchName: string | null;
  readonly url: string | null;
  readonly labels: readonly string[];
  readonly blockedBy: readonly {
    readonly id: string | null;
    readonly identifier: string | null;
    readonly state: string | null;
  }[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface LiveSessionWire {
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly agentRuntimePid: string | null;
  readonly lastAgentEvent: string | null;
  readonly lastAgentTimestamp: string | null;
  readonly lastAgentMessage: string | null;
  readonly tokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly lastReportedInputTokens: number;
    readonly lastReportedOutputTokens: number;
    readonly lastReportedTotalTokens: number;
  };
  readonly turnCount: number;
}

export interface RetryEntryWire {
  readonly id: string;
  readonly identifier: string;
  readonly attempt: number;
  /** Last error string, if the retry was scheduled by a failure. */
  readonly error: string | null;
  /** ISO-8601 of when the retry will fire (best-effort wall clock). */
  readonly dueAtIso: string;
  /** Milliseconds-from-now (using server clock at snapshot time). */
  readonly dueInMs: number;
}

/**
 * Top-level response shape for `GET /api/v1/state`.
 *
 * `now` and `daemonStartedAt` exist so the dashboard can compute
 * uptime and "X seconds ago" without trusting the client's clock.
 */
export interface StateSnapshotWire {
  readonly pollIntervalMs: number;
  readonly maxConcurrentAgents: number;
  readonly running: readonly RunningEntryWire[];
  readonly claimed: readonly string[];
  readonly retryAttempts: readonly RetryEntryWire[];
  readonly completed: readonly string[];
  readonly agentTotals: AgentTotals;
  readonly agentRateLimits: unknown;
  readonly now: string;
  readonly daemonStartedAt: string;
}

// ---- Conversion -----------------------------------------------------

export interface SerializeArgs {
  readonly state: OrchestratorState;
  readonly now: Date;
  readonly daemonStartedAt: Date;
  /**
   * Reference clock (ms since some epoch) used to compute
   * `nextDueInMs` for retries. Pass the same monotonic clock the
   * orchestrator uses for retry scheduling so the math is internally
   * consistent.
   */
  readonly monotonicNowMs: number;
}

export function serializeState(args: SerializeArgs): StateSnapshotWire {
  const { state } = args;
  return {
    pollIntervalMs: state.pollIntervalMs,
    maxConcurrentAgents: state.maxConcurrentAgents,
    running: Array.from(state.running.entries()).map(([id, entry]) => ({
      id,
      issue: serializeIssue(entry.issue),
      session: serializeSession(entry.session),
      startedAt: entry.startedAt.toISOString(),
      retryAttempt: entry.retryAttempt,
    })),
    claimed: Array.from(state.claimed.values()),
    retryAttempts: Array.from(state.retryAttempts.entries()).map(([id, entry]) =>
      serializeRetry(id, entry, args.monotonicNowMs, args.now),
    ),
    completed: Array.from(state.completed.values()),
    agentTotals: { ...state.agentTotals },
    agentRateLimits: state.agentRateLimits,
    now: args.now.toISOString(),
    daemonStartedAt: args.daemonStartedAt.toISOString(),
  };
}

function serializeIssue(issue: Issue): IssueWire {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branchName: issue.branchName,
    url: issue.url,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    createdAt: issue.createdAt === null ? null : issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt === null ? null : issue.updatedAt.toISOString(),
  };
}

function serializeSession(session: LiveSession): LiveSessionWire {
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    turnId: session.turnId,
    agentRuntimePid: session.agentRuntimePid,
    lastAgentEvent: session.lastAgentEvent,
    lastAgentTimestamp:
      session.lastAgentTimestamp === null ? null : session.lastAgentTimestamp.toISOString(),
    lastAgentMessage: session.lastAgentMessage,
    tokens: { ...session.tokens },
    turnCount: session.turnCount,
  };
}

function serializeRetry(
  id: string,
  entry: RetryEntry,
  monotonicNowMs: number,
  wallClockNow: Date,
): RetryEntryWire {
  // The orchestrator stores `dueAtMs` as a monotonic-clock value
  // (matches `performance.now()` semantics). We project that onto
  // wall-clock for display purposes by adding the (signed) delta
  // to the current time. This isn't perfectly accurate across NTP
  // jumps but it's only used for human-readable countdowns.
  const deltaMs = entry.dueAtMs - monotonicNowMs;
  const dueAtWallMs = wallClockNow.getTime() + deltaMs;
  return {
    id,
    identifier: entry.identifier,
    attempt: entry.attempt,
    error: entry.error,
    dueAtIso: new Date(dueAtWallMs).toISOString(),
    dueInMs: Math.max(0, Math.round(deltaMs)),
  };
}
