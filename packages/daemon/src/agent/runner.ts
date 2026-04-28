// `AgentRunner` — the interface every agent backend implements.
//
// Per ADR 0001 the daemon abstracts away which agent runs the work.
// `MockAgent` (Plan 04, this layer) and `ClaudeAgent` (Plan 07) both
// implement this interface. The orchestrator only ever talks to
// `AgentRunner`.
//
// Events are exposed as an `AsyncIterable` because:
//   - it matches the streaming nature of agent runs (events trickle
//     out over seconds-to-hours),
//   - it composes cleanly with `for await` in the worker loop,
//   - cancellation can be modeled by breaking out of the loop and
//     calling a separate `cancel()` method, which keeps the contract
//     small for now.

import type { IssueId, IssueIdentifier, SessionId } from '../types/index.js';

/**
 * Inputs to a single agent run.
 *
 * `attempt` is `null` on the first run and `>= 1` on retries /
 * continuations (per SPEC §4.1.5 and Plan 05). The orchestrator
 * passes the value through; the agent layer is free to use it (e.g.
 * for retry-aware prompting) or ignore it.
 */
export interface AgentRunInput {
  readonly issueId: IssueId;
  readonly issueIdentifier: IssueIdentifier;
  /** Absolute path to the per-issue workspace. Must be the agent's cwd. */
  readonly workspacePath: string;
  /** Already-rendered prompt string (the workflow body for this issue). */
  readonly prompt: string;
  readonly attempt: number | null;
  /**
   * Optional cancellation signal. If aborted, the agent SHOULD
   * terminate the run as quickly as it can and stop yielding events.
   */
  readonly signal?: AbortSignal;
}

/**
 * Events emitted during a run. Discriminated on `kind` for exhaustive
 * switch handling. The list is intentionally small for Plan 04 — the
 * Claude SDK adapter (Plan 07) will produce a richer set including
 * tool calls, token usage, rate limits, etc.
 */
export type AgentEvent =
  | SessionStartedEvent
  | NotificationEvent
  | TurnCompletedEvent
  | TurnFailedEvent;

export interface SessionStartedEvent {
  readonly kind: 'session_started';
  /** Composite `<threadId>-<turnId>`. */
  readonly sessionId: SessionId;
  readonly threadId: string;
  readonly turnId: string;
  readonly at: Date;
}

export interface NotificationEvent {
  readonly kind: 'notification';
  /** Short, human-oriented status message. Used for UI/log display. */
  readonly message: string;
  readonly at: Date;
}

export interface TurnCompletedEvent {
  readonly kind: 'turn_completed';
  readonly at: Date;
  /**
   * Turn count within the current run lifetime, 1-based. The
   * orchestrator uses this for the snapshot's `turn_count` field.
   */
  readonly turnNumber: number;
}

export interface TurnFailedEvent {
  readonly kind: 'turn_failed';
  readonly reason: string;
  readonly at: Date;
}

/**
 * Run an agent against one issue. Returns an async iterable of events.
 *
 * Lifecycle:
 *   1. The orchestrator constructs `AgentRunInput` and calls `run`.
 *   2. The agent yields `session_started` first (if it can — some
 *      backends may emit notifications before a session is fully
 *      started; the orchestrator tolerates this).
 *   3. The agent yields zero or more `notification` events.
 *   4. The agent yields exactly one terminal event:
 *      `turn_completed` (success) or `turn_failed` (failure).
 *   5. The iterable ends.
 *
 * If the iterable ends without a terminal event, the orchestrator
 * treats the run as an abnormal exit.
 */
export interface AgentRunner {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}
