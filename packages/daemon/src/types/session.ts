// `LiveSession` per SPEC §4.1.6.
//
// State tracked while a coding-agent run is in flight. The spec uses
// `codex_*` field names; per ADR 0008 we rename to `agent_*` here for
// the same reason we did for the config schema. Field semantics are
// preserved verbatim from the spec.

import type { SessionId } from './ids.js';

/**
 * Token counters reported by the agent. Per SPEC §13.5, we prefer
 * absolute thread totals when available and track deltas relative to
 * the last reported totals to avoid double-counting across turns.
 */
export interface AgentTokenCounters {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly lastReportedInputTokens: number;
  readonly lastReportedOutputTokens: number;
  readonly lastReportedTotalTokens: number;
}

/**
 * Live agent session metadata. One per active run.
 *
 * Field renames from SPEC §4.1.6 (per ADR 0008):
 *   codex_app_server_pid  -> agentRuntimePid
 *   last_codex_event      -> lastAgentEvent
 *   last_codex_timestamp  -> lastAgentTimestamp
 *   last_codex_message    -> lastAgentMessage
 *   codex_*_tokens        -> see AgentTokenCounters
 */
export interface LiveSession {
  /** Composite `<threadId>-<turnId>` per SPEC §4.2. */
  readonly sessionId: SessionId;
  readonly threadId: string;
  readonly turnId: string;
  /**
   * OS-level PID of the agent runtime, when applicable. The Claude
   * Agent SDK runs in-process so this is typically `null`. Kept for
   * parity with the spec field and possible future remote-runtime
   * extensions.
   */
  readonly agentRuntimePid: string | null;
  readonly lastAgentEvent: string | null;
  readonly lastAgentTimestamp: Date | null;
  readonly lastAgentMessage: string | null;
  readonly tokens: AgentTokenCounters;
  /** Number of turns started in this worker's lifetime. SPEC §4.1.6. */
  readonly turnCount: number;
}
