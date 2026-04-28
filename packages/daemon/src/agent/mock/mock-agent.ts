// `MockAgent` — the dev/test implementation of `AgentRunner`.
//
// Configurable to simulate any of the outcomes the orchestrator needs
// to handle:
//   - normal success (turn_completed)
//   - failure (turn_failed)
//   - never completes (for stall-detection tests, Plan 05)
//   - emits notifications along the way
//
// The agent ignores the actual workspace path and prompt content; it
// only sleeps and emits events. That's enough to drive the
// orchestrator end-to-end against fixture data.

import { composeSessionId } from '../../types/index.js';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRunner,
  TurnCompletedEvent,
  TurnFailedEvent,
} from '../runner.js';

export interface MockAgentOptions {
  /** How long the mock turn pretends to take (ms). Default 100ms. */
  readonly turnDurationMs?: number;
  /** Final outcome of the run. Default 'success'. */
  readonly outcome?: 'success' | 'failure' | 'never_completes';
  /**
   * Notifications to emit between session start and the terminal
   * event. Each notification is emitted with a small delay so the
   * orchestrator's event-handling code is exercised over time, not
   * in a single tick.
   */
  readonly notifications?: readonly string[];
  /**
   * Optional fixed thread/turn IDs. Useful in tests that assert on
   * specific session IDs. When omitted we generate `mock-<random>`
   * values so concurrent runs don't collide.
   */
  readonly threadId?: string;
  readonly turnId?: string;
}

/** Node's `setTimeout` returns an opaque handle; this is the abortable Promise wrapper. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

let counter = 0;

interface ResolvedOptions {
  readonly turnDurationMs: number;
  readonly outcome: 'success' | 'failure' | 'never_completes';
  readonly notifications: readonly string[];
  readonly threadIdOverride: string | null;
  readonly turnIdOverride: string | null;
}

export class MockAgent implements AgentRunner {
  private readonly options: ResolvedOptions;

  constructor(options: MockAgentOptions = {}) {
    // We normalize "no override given" to `null` (rather than
    // `undefined`) so the stored shape is fully concrete — playing
    // nicely with `exactOptionalPropertyTypes: true` in tsconfig.
    this.options = {
      turnDurationMs: options.turnDurationMs ?? 100,
      outcome: options.outcome ?? 'success',
      notifications: options.notifications ?? [],
      threadIdOverride: options.threadId ?? null,
      turnIdOverride: options.turnId ?? null,
    };
  }

  run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const { turnDurationMs, outcome, notifications, threadIdOverride, turnIdOverride } =
      this.options;
    counter += 1;
    const threadId = threadIdOverride ?? `mock-thread-${counter}`;
    const turnId = turnIdOverride ?? `mock-turn-${counter}`;

    return {
      async *[Symbol.asyncIterator]() {
        // 1. Session start.
        yield {
          kind: 'session_started',
          sessionId: composeSessionId(threadId, turnId),
          threadId,
          turnId,
          at: new Date(),
        } satisfies AgentEvent;

        // 2. Notifications, evenly spaced across the turn's wall-clock budget.
        const slice =
          notifications.length > 0
            ? Math.max(1, Math.floor(turnDurationMs / (notifications.length + 1)))
            : 0;
        for (const message of notifications) {
          await delay(slice, input.signal);
          yield {
            kind: 'notification',
            message,
            at: new Date(),
          } satisfies AgentEvent;
        }

        // 3. Terminal event (or hang forever, for stall tests).
        if (outcome === 'never_completes') {
          // Wait until aborted. We don't yield anything else; the
          // orchestrator's stall detection (Plan 05) is responsible
          // for killing us via signal.
          await new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => {
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
          return;
        }

        // Use any remaining slice as the "do real work" gap before
        // the terminal event.
        const remaining = Math.max(0, turnDurationMs - notifications.length * slice);
        await delay(remaining, input.signal);

        if (outcome === 'success') {
          const event: TurnCompletedEvent = {
            kind: 'turn_completed',
            at: new Date(),
            turnNumber: 1,
          };
          yield event;
        } else {
          const event: TurnFailedEvent = {
            kind: 'turn_failed',
            reason: 'mock-agent configured for failure',
            at: new Date(),
          };
          yield event;
        }
      },
    };
  }
}
