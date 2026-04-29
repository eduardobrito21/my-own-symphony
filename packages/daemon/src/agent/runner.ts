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
 * switch handling. The list grew with Plan 07 to cover Claude Agent
 * SDK semantics: tool invocations and per-turn token usage.
 *
 * Backward-compatibility contract: this union is **additive only**.
 * Existing consumers that handle the four original kinds continue to
 * work — they will simply ignore any new event kinds. Code that wants
 * to react to the new kinds must opt in by adding cases.
 */
export type AgentEvent =
  | SessionStartedEvent
  | NotificationEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
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
 * The agent invoked a tool. Plan 07 introduces this event to surface
 * activity that's invisible to plain `notification` events — namely
 * the agent's `linear_graphql` calls and any future custom tools.
 *
 * `callId` is a correlation key for matching this call to its
 * `tool_result`. The Claude Agent SDK supplies a stable id; for
 * other backends we may synthesize one (e.g. monotonic counter).
 *
 * `input` is the *structured* tool input as a JS value, NOT a
 * stringified JSON. Consumers that want to log it should stringify
 * themselves and apply their own truncation.
 */
export interface ToolCallEvent {
  readonly kind: 'tool_call';
  readonly callId: string;
  /**
   * Tool name as the agent invoked it. For SDK MCP tools this looks
   * like `mcp__<server>__<tool>`; for built-ins it is just the bare
   * name (e.g. `Read`).
   */
  readonly toolName: string;
  readonly input: unknown;
  readonly at: Date;
}

/**
 * A tool returned. Pairs with a prior `tool_call` via `callId`.
 *
 * `content` is a flat string. Tools may return rich content blocks
 * (text + image + resource); we collapse to text-only and let the
 * agent runner decide truncation. Truncation is applied to keep
 * orchestrator state bounded — heavy payloads are still available
 * to the agent itself, just not in the orchestrator's snapshot.
 */
export interface ToolResultEvent {
  readonly kind: 'tool_result';
  readonly callId: string;
  /** True if the tool reported an error. SDK contract: `isError` flag. */
  readonly isError: boolean;
  readonly content: string;
  readonly at: Date;
}

/**
 * Token usage and cost from a single turn. Plan 07 emits this
 * **once per turn**, immediately before the terminal
 * `turn_completed` / `turn_failed` event, because the Claude Agent
 * SDK only reports usage at the end of a `query()` call.
 *
 * Per-turn semantics (NOT cumulative across resumed sessions):
 * `inputTokens` / `outputTokens` reflect only the tokens consumed
 * by this specific turn. The orchestrator accumulates them into
 * `agentTotals` directly — no diff math needed.
 *
 * Cache fields are `null` when the model didn't report cache
 * activity. `totalCostUsd` is `null` when the SDK doesn't surface
 * a cost figure (e.g. when running through a non-Anthropic
 * provider or when the host doesn't have billing visibility).
 */
export interface UsageEvent {
  readonly kind: 'usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly totalCostUsd: number | null;
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
