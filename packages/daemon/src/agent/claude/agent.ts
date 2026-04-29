// `ClaudeAgent` — drives the Claude Agent SDK on a single Linear
// issue. Implements the same `AgentRunner` interface MockAgent uses,
// so swapping it in is a config flip in `index.ts`.
//
// Responsibilities (per Plan 07):
//
//   1. Build the `linear_graphql` MCP tool once at construction
//      and register it with the SDK on every call. The tool reuses
//      the same `LinearClient` instance the tracker uses, so auth
//      and transport are a single source of truth.
//
//   2. On each `run()` call (= one orchestrator dispatch = one
//      SDK turn):
//        a. Bridge the orchestrator's AbortSignal to the SDK's
//           AbortController.
//        b. Load any existing `session.json` for the workspace.
//        c. Try to call the SDK with `resume: <id>` if a session
//           exists; on resume failure (SDK throws before yielding
//           anything), log INFO and retry once without resume.
//        d. Iterate SDK messages, map to AgentEvents, and yield
//           them to the orchestrator. The mapping itself lives in
//           `event-mapping.ts` and is tested independently.
//        e. Persist the (possibly new) session_id to disk so the
//           next dispatch can resume.
//
// What this file is NOT responsible for:
//   - Orchestrating multi-turn flow. That's the orchestrator's
//     retry queue (Plan 5). One call = one turn.
//   - Aborting on a stall. The orchestrator already aborts via
//     `input.signal`; we just respect it.
//   - Token accounting. We emit `usage` events; the orchestrator
//     accumulates them.
//
// Risk: the SDK has a known bug (GitHub #69) where aborting
// immediately after the init message and then resuming fails. We
// don't actively work around it; if a resume fails on the next
// turn we delete the session file and start fresh.

import {
  query as sdkQuery,
  tool,
  createSdkMcpServer,
  type Query,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { Logger } from '../../observability/index.js';
import type { LinearClient } from '../../tracker/linear/client.js';
import type { AgentEvent, AgentRunInput, AgentRunner } from '../runner.js';

import { mapSdkMessage } from './event-mapping.js';
import { loadSessionOrNull, saveSession, type SessionRecord } from './session-store.js';
import { executeLinearGraphql, toCallToolResult } from '../tools/linear-graphql.js';

/** Default to Haiku for low-cost Linear automation. */
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * Indirection over the SDK's `query` function so tests can stub the
 * SDK without touching the network. Production injects the real one.
 */
export type QueryFn = typeof sdkQuery;

type ThinkingDisplay = 'summarized' | 'omitted';

export type ClaudeThinkingConfig =
  | { readonly type: 'disabled' }
  | { readonly type: 'adaptive'; readonly display?: ThinkingDisplay | undefined }
  | {
      readonly type: 'enabled';
      readonly budgetTokens?: number | undefined;
      readonly display?: ThinkingDisplay | undefined;
    };

export interface ClaudeAgentArgs {
  /** Shared LinearClient — same instance the tracker uses. */
  readonly linearClient: LinearClient;
  /** Markdown skill text to inject as the system prompt every call. */
  readonly skillMarkdown: string;
  readonly logger: Logger;
  /** Override the default Haiku 4.5 alias. */
  readonly model?: string;
  /** Claude SDK thinking/reasoning behavior. */
  readonly thinking?: ClaudeThinkingConfig;
  /** Maximum Claude SDK model round trips inside one query call. */
  readonly maxModelRoundTrips?: number;
  /** Optional SDK cost guard for one query call. */
  readonly maxBudgetUsd?: number;
  /** Test seam — defaults to the real SDK `query`. */
  readonly queryFn?: QueryFn;
  /** Test seam — defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export class ClaudeAgent implements AgentRunner {
  private readonly linearClient: LinearClient;
  private readonly skillMarkdown: string;
  private readonly logger: Logger;
  private readonly model: string;
  private readonly thinking: ThinkingConfig | undefined;
  private readonly maxModelRoundTrips: number | undefined;
  private readonly maxBudgetUsd: number | undefined;
  private readonly queryFn: QueryFn;
  private readonly now: () => Date;
  private readonly mcpServer: ReturnType<typeof createSdkMcpServer>;

  constructor(args: ClaudeAgentArgs) {
    this.linearClient = args.linearClient;
    this.skillMarkdown = args.skillMarkdown;
    this.logger = args.logger;
    this.model = args.model ?? DEFAULT_MODEL;
    this.thinking = toSdkThinkingConfig(args.thinking);
    this.maxModelRoundTrips = args.maxModelRoundTrips;
    this.maxBudgetUsd = args.maxBudgetUsd;
    this.queryFn = args.queryFn ?? sdkQuery;
    this.now = args.now ?? (() => new Date());
    this.mcpServer = this.buildLinearMcpServer();
  }

  /**
   * Construct the `linear_graphql` MCP server once at class
   * construction. Reused across all runs.
   *
   * The handler closure captures `this.linearClient` so the agent's
   * tool calls flow through the same auth/transport as the tracker.
   */
  private buildLinearMcpServer(): ReturnType<typeof createSdkMcpServer> {
    const linearTool = tool(
      'linear_graphql',
      'Execute a GraphQL query or mutation against the Linear API. ' +
        'Input: { query: string, variables?: object }. ' +
        'Returns a JSON-stringified payload: { success, data, errors, http_status }. ' +
        'Use this to fetch issue metadata, post comments, transition states, etc. ' +
        'See the system prompt for the safe-default operating rules.',
      {
        query: z.string().describe('GraphQL query or mutation string.'),
        variables: z
          .record(z.unknown())
          .optional()
          .describe('Optional variable map for the GraphQL operation.'),
      },
      async (args) => {
        // exactOptionalPropertyTypes: only include `variables` when
        // the agent actually supplied them.
        const payload = await executeLinearGraphql(this.linearClient, {
          query: args.query,
          ...(args.variables !== undefined && { variables: args.variables }),
        });
        return toCallToolResult(payload);
      },
    );
    return createSdkMcpServer({
      name: 'linear',
      version: '1.0.0',
      tools: [linearTool],
    });
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const log = this.logger.with({
      issue_identifier: input.issueIdentifier,
      issue_id: input.issueId,
    });
    const abortController = this.bridgeSignal(input.signal);
    const existing = await loadSessionOrNull(input.workspacePath, log);
    const turnNumber = (input.attempt ?? 0) + 1;

    log.info('claude_turn_started', {
      model: this.model,
      attempt: input.attempt,
      resume_session: existing?.sessionId ?? null,
    });

    // The runner attempts at most two passes: first with `resume`,
    // second (if resume fails before yielding anything) without.
    // We model this as a bounded for-loop instead of `while (true)`
    // so the maximum number of attempts is mechanically obvious.
    let yieldedAny = false;
    let resumeWith: SessionRecord | null = existing;
    let observedSessionId: string | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let q: Query;
      try {
        q = this.queryFn({
          prompt: input.prompt,
          options: {
            model: this.model,
            systemPrompt: this.skillMarkdown,
            mcpServers: { linear: this.mcpServer },
            tools: [],
            allowedTools: ['mcp__linear__linear_graphql'],
            cwd: input.workspacePath,
            abortController,
            ...(this.thinking !== undefined && { thinking: this.thinking }),
            ...(this.maxModelRoundTrips !== undefined && { maxTurns: this.maxModelRoundTrips }),
            ...(this.maxBudgetUsd !== undefined && { maxBudgetUsd: this.maxBudgetUsd }),
            ...(resumeWith !== null && { resume: resumeWith.sessionId }),
            // INTENTIONALLY DO NOT set persistSession: false. The
            // SDK's `resume:` option requires the SDK to have the
            // session in its own ~/.claude/projects/ store —
            // disabling persistence makes resume permanently fail
            // with "No conversation found with session ID: …" on
            // every dispatch after the first. (Bug 3, smoke run #2,
            // 2026-04-29.) Our `session.json` is a workspace-local
            // pointer to the latest session id; the SDK's per-user
            // store holds the full transcript needed for resume.
          },
        });
      } catch (cause) {
        // Synchronous throw from queryFn. We have not yielded
        // anything yet (still in the same loop iteration as the
        // call). If we tried resume, fall back to fresh on the
        // next attempt; otherwise this is a hard failure.
        if (resumeWith !== null) {
          log.warn('claude_resume_failed_starting_fresh', {
            session_id: resumeWith.sessionId,
            error: stringifyCause(cause),
          });
          resumeWith = null;
          continue;
        }
        yield this.failedEvent(`SDK call failed: ${stringifyCause(cause)}`);
        return;
      }

      // Single-terminal invariant (SPEC AgentEvent contract):
      // exactly one of `turn_completed` / `turn_failed` per run. We
      // buffer the SDK-reported terminal instead of forwarding it
      // immediately, so that if the SDK throws AFTER reporting
      // "success" (Bug 2 from the Plan 07 smoke run, 2026-04-29 —
      // Anthropic returned `result subtype=success` with empty
      // usage when credits were exhausted, then the underlying CLI
      // exited nonzero and surfaced as a thrown error), we treat
      // the throw as authoritative and reclassify the run as failed.
      let bufferedTerminal: AgentEvent | null = null;
      let needsRetryWithoutResume = false;
      let aborted = false;
      try {
        for await (const sdkMsg of q) {
          const events = mapSdkMessage(sdkMsg, {
            turnNumber,
            now: this.now,
          });
          for (const event of events) {
            if (event.kind === 'session_started') {
              observedSessionId = event.sessionId;
              yieldedAny = true;
              yield event;
            } else if (event.kind === 'turn_completed' || event.kind === 'turn_failed') {
              // Buffer; do not forward yet. A later throw can
              // reclassify this.
              bufferedTerminal = event;
            } else {
              yieldedAny = true;
              yield event;
            }
          }
        }
      } catch (cause) {
        // Mid-stream errors: if we tried resume and the SDK never
        // emitted a `system: init` message (`observedSessionId` is
        // still null), the resume was rejected before the
        // conversation could start. Fall back to a fresh session.
        //
        // We deliberately use `observedSessionId === null` instead of
        // `!yieldedAny` because the SDK's resume-rejection path emits
        // a zero-token `result` message that maps to a `usage` event
        // (yielded immediately, sets `yieldedAny=true`) AND a
        // `turn_failed` (buffered). Without this signal, the catch
        // would fall into the post-terminal reclassify branch instead
        // of retrying — that was Bug 4 from smoke run #3, 2026-04-29.
        if (resumeWith !== null && observedSessionId === null) {
          log.warn('claude_resume_failed_starting_fresh', {
            session_id: resumeWith.sessionId,
            error: stringifyCause(cause),
          });
          resumeWith = null;
          needsRetryWithoutResume = true;
        } else if (bufferedTerminal !== null) {
          // The SDK reported a terminal but then threw before the
          // stream cleanly closed. Trust the throw — it tells us
          // the underlying transport failed, and the buffered
          // "success" is suspect (e.g. zero-token success because
          // the API rejected the request). Discard the buffered
          // terminal and emit a turn_failed instead.
          log.warn('claude_post_terminal_error_reclassified', {
            buffered_kind: bufferedTerminal.kind,
            error: stringifyCause(cause),
          });
          yield this.failedEvent(
            `SDK iteration failed after buffered ${bufferedTerminal.kind}: ${stringifyCause(cause)}`,
          );
          aborted = true;
        } else {
          log.error('claude_turn_errored', {
            error: stringifyCause(cause),
            yielded_any: yieldedAny,
          });
          yield this.failedEvent(`SDK iteration failed: ${stringifyCause(cause)}`);
          aborted = true;
        }
      } finally {
        // Best-effort cleanup. `Query.close()` is idempotent per the
        // SDK docs; calling it after natural completion is a no-op.
        try {
          q.close();
        } catch {
          /* intentionally empty */
        }
      }

      if (needsRetryWithoutResume) continue;
      if (aborted) return;

      // Resume may also fail "cleanly" — the SDK closes its iterator
      // without throwing but the only thing we got was a buffered
      // `turn_failed` and we never observed a `session_started`. This
      // is the same logical case as the catch-block resume failure
      // above; treat it the same way and retry without resume.
      if (
        resumeWith !== null &&
        observedSessionId === null &&
        bufferedTerminal?.kind === 'turn_failed'
      ) {
        log.warn('claude_resume_failed_starting_fresh', {
          session_id: resumeWith.sessionId,
          reason: bufferedTerminal.reason,
        });
        resumeWith = null;
        continue;
      }

      // Iteration ended cleanly. Yield the buffered terminal if we
      // got one, or synthesize a failure if the SDK closed without
      // ever reporting a result (defensive — should not happen).
      if (bufferedTerminal !== null) {
        yield bufferedTerminal;
      } else {
        log.warn('claude_iteration_closed_without_terminal', {});
        yield this.failedEvent('SDK iteration ended without a terminal event');
      }

      // Persist the session id we observed (or keep the existing
      // one if the SDK didn't surface a fresh init this turn —
      // happens on resumed sessions).
      const sessionToSave = observedSessionId ?? existing?.sessionId ?? null;
      if (sessionToSave !== null) {
        await this.persistSession(input.workspacePath, sessionToSave, existing);
      }
      log.info('claude_turn_ended', {
        observed_session_id: observedSessionId,
        resume_attempted: existing !== null,
      });
      return;
    }
  }

  /**
   * Build an AbortController whose `abort()` fires when either:
   *   - the orchestrator-supplied signal aborts (stall / shutdown),
   *   - or the run completes (we still call `close()` on the Query).
   */
  private bridgeSignal(signal: AbortSignal | undefined): AbortController {
    const controller = new AbortController();
    if (signal === undefined) return controller;
    if (signal.aborted) {
      controller.abort();
      return controller;
    }
    signal.addEventListener(
      'abort',
      () => {
        controller.abort();
      },
      { once: true },
    );
    return controller;
  }

  private failedEvent(reason: string): AgentEvent {
    return { kind: 'turn_failed', reason, at: this.now() };
  }

  private async persistSession(
    workspacePath: string,
    sessionId: string,
    previous: SessionRecord | null,
  ): Promise<void> {
    const nowIso = this.now().toISOString();
    const record: SessionRecord = {
      sessionId,
      createdAt: previous?.sessionId === sessionId ? previous.createdAt : nowIso,
      lastTurnAt: nowIso,
      model: this.model,
    };
    try {
      await saveSession(workspacePath, record);
    } catch (cause) {
      // Saving session is best-effort. A failure here means the
      // next turn starts a fresh SDK session — annoying but not
      // wrong. Logged and swallowed.
      this.logger.warn('claude_session_persist_failed', {
        workspace_path: workspacePath,
        error: stringifyCause(cause),
      });
    }
  }
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

function toSdkThinkingConfig(config: ClaudeThinkingConfig | undefined): ThinkingConfig | undefined {
  if (config === undefined || config.type === 'disabled') return config;
  if (config.type === 'adaptive') {
    return {
      type: 'adaptive',
      ...(config.display !== undefined && { display: config.display }),
    };
  }
  return {
    type: 'enabled',
    ...(config.budgetTokens !== undefined && { budgetTokens: config.budgetTokens }),
    ...(config.display !== undefined && { display: config.display }),
  };
}
