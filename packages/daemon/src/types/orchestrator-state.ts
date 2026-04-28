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

import type { IssueId } from './ids.js';
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
   * Latest rate-limit payload seen on any agent event. Shape is
   * agent-specific; we model it as `unknown` (which already includes
   * `null`) until Plan 07 lands the Claude SDK adapter and we know
   * the concrete type. `null` is the initial value before any agent
   * event arrives.
   */
  readonly agentRateLimits: unknown;
}
