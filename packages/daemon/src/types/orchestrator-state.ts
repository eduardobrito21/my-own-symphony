// `OrchestratorState` skeleton per SPEC §4.1.8.
//
// The full state machine, mutators, and tick logic live in the
// orchestrator layer (Plan 04). This file just nails down the shape so
// that other layers (HTTP API, observability snapshot helpers) can
// consume it as a typed value.
//
// Per ADR 0008, fields named `codex_*` in the spec are renamed to
// `agent_*`:
//   codex_totals      -> agentTotals
//   codex_rate_limits -> agentRateLimits

import type { IssueId, ProjectKey } from './ids.js';
import type { Issue } from './issue.js';
import type { RetryEntry } from './retry-entry.js';
import type { LiveSession } from './session.js';

/**
 * Aggregate token + runtime counters across all completed and active
 * sessions. SPEC §13.5.
 */
export interface AgentTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly secondsRunning: number;
}

/**
 * One row in the `running` map: the issue currently being worked on
 * plus the live session metadata for it.
 */
export interface RunningEntry {
  readonly issue: Issue;
  readonly session: LiveSession;
  readonly startedAt: Date;
  readonly retryAttempt: number | null;
}

/**
 * Per-project breakdown of orchestrator state (ADR 0009 / Plan 09).
 * Counters here are derivable from `running` / `retryAttempts` /
 * `completed` plus each issue's `projectKey`, but precomputing them
 * makes the dashboard's per-project panel a constant-time lookup
 * rather than a fold across every entry on every snapshot.
 */
export interface ProjectSnapshot {
  readonly projectKey: ProjectKey;
  readonly running: number;
  readonly retrying: number;
  readonly completed: number;
}

/**
 * The single-authority orchestrator state. Plan 04 defines the
 * mutator surface; consumers here are read-only.
 */
export interface OrchestratorState {
  readonly pollIntervalMs: number;
  readonly maxConcurrentAgents: number;
  readonly running: ReadonlyMap<IssueId, RunningEntry>;
  /** IDs reserved (running OR retrying) — prevents duplicate dispatch. */
  readonly claimed: ReadonlySet<IssueId>;
  readonly retryAttempts: ReadonlyMap<IssueId, RetryEntry>;
  /** Bookkeeping only; not used to gate dispatch. */
  readonly completed: ReadonlySet<IssueId>;
  readonly agentTotals: AgentTotals;
  /**
   * Per-project breakdown — one entry per project the daemon is
   * watching, with running/retrying/completed counts. Stable order
   * is the project order from the deployment YAML so the dashboard
   * doesn't reshuffle on every poll.
   */
  readonly projects: readonly ProjectSnapshot[];
  /**
   * Latest rate-limit payload seen on any agent event. Shape is
   * agent-specific; we model it as `unknown` (which already includes
   * `null`) until Plan 07 lands the Claude SDK adapter and we know
   * the concrete type. `null` is the initial value before any agent
   * event arrives.
   */
  readonly agentRateLimits: unknown;
}
