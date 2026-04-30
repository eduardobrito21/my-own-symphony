// Wire types for `GET /api/v1/state`. Mirror of
// `packages/daemon/src/http/serialize.ts`.
//
// We don't import directly from the daemon package — the dashboard
// must be loadable without the daemon's runtime deps. Hand-mirroring
// is cheap (a few interfaces) and the daemon's tests pin the wire
// shape, so drift is caught early.

export interface IssueWire {
  id: string;
  identifier: string;
  /** Multi-project (Plan 09c): which Linear project the issue
   *  belongs to. Defaults to `"default"` for legacy single-project
   *  deployments. */
  projectKey: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: { id: string | null; identifier: string | null; state: string | null }[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LiveSessionWire {
  sessionId: string;
  threadId: string;
  turnId: string;
  agentRuntimePid: string | null;
  lastAgentEvent: string | null;
  lastAgentTimestamp: string | null;
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

export interface RunningEntryWire {
  id: string;
  issue: IssueWire;
  session: LiveSessionWire;
  startedAt: string;
  retryAttempt: number | null;
}

export interface RetryEntryWire {
  id: string;
  identifier: string;
  attempt: number;
  error: string | null;
  dueAtIso: string;
  dueInMs: number;
}

export interface AgentTotalsWire {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

/**
 * Per-project counters (Plan 09c). One entry per project the daemon
 * is watching, in deployment YAML order. Empty array for tests /
 * single-project legacy deployments.
 */
export interface ProjectSnapshotWire {
  projectKey: string;
  running: number;
  retrying: number;
  completed: number;
}

export interface StateSnapshotWire {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: RunningEntryWire[];
  claimed: string[];
  retryAttempts: RetryEntryWire[];
  completed: string[];
  agentTotals: AgentTotalsWire;
  /** Per-project breakdown for the dashboard's grouping panel. */
  projects: ProjectSnapshotWire[];
  agentRateLimits: unknown;
  now: string;
  daemonStartedAt: string;
}
