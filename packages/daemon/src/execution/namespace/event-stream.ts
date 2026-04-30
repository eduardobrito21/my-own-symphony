// Parse `AgentEvent`s from the streaming stdout chunks of the
// agent-runtime process running on a Namespace VM.
//
// The agent-runtime entrypoint, when running in stdout-mode (i.e.
// when `SYMPHONY_EVENT_HOST` is unset), writes one `AgentEvent` per
// line as JSON to stdout. The Namespace SDK's `runCommand` returns
// a server-streaming response of byte chunks. Lines may straddle
// chunk boundaries; we buffer until newline.
//
// Mirrors `local-docker/socket-server.ts`'s parsing — same wire
// format, different transport. The schema-validation logic is
// identical (zod permissive-base, additive event-kind contract).

import { z } from 'zod';

import type { AgentEvent } from '../../agent/runner.js';

import type { InstanceRunner, RunCommandArgs, RunCommandChunk } from './instance-runner.js';

const WireEventBaseSchema = z
  .object({
    kind: z.string().min(1),
    at: z.string().datetime({ offset: true }),
  })
  .passthrough();

/**
 * Wrap a streaming `runCommand` invocation as an
 * `AsyncIterable<AgentEvent>`. Yields parsed events from stdout
 * lines; ignores stderr (callers can collect stderr via
 * `logsTail` if they want to surface it for diagnostics).
 *
 * Iteration ends when:
 *   - the upstream stream emits a terminal `exit` chunk, OR
 *   - the agent emits a terminal event (`turn_completed` /
 *     `turn_failed`), OR
 *   - the abort signal fires.
 */
export function streamAgentEvents(
  runner: InstanceRunner,
  args: RunCommandArgs,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      let buffer = '';
      const upstream = runner.runCommandStream(args, signal);
      for await (const chunk of upstream) {
        if (chunk.kind === 'exit') {
          // Flush any trailing partial line before terminating.
          const trailing = buffer.trim();
          if (trailing.length > 0) {
            const event = parseLine(trailing);
            if (event !== null) yield event;
          }
          return;
        }
        if (chunk.stream !== 'stdout') continue;
        buffer += chunk.data;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.length === 0) continue;
          const event = parseLine(line);
          if (event === null) continue;
          yield event;
          if (event.kind === 'turn_completed' || event.kind === 'turn_failed') {
            return;
          }
        }
      }
    },
  };
}

function parseLine(line: string): AgentEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const validation = WireEventBaseSchema.safeParse(parsed);
  if (!validation.success) return null;
  const data = validation.data as Record<string, unknown> & { kind: string; at: string };
  return { ...data, at: new Date(data.at) } as unknown as AgentEvent;
}

/** Collect stdout/stderr buffers from a streaming runCommand into
 *  a single tail-style string. Used by `PodHandle.logsTail()` for
 *  diagnostics. The buffer is bounded (last N bytes only). */
export function collectLastBytes(
  upstream: AsyncIterable<RunCommandChunk>,
  maxBytes: number,
): Promise<string> {
  return (async () => {
    let combined = '';
    for await (const chunk of upstream) {
      if (chunk.kind !== 'data') continue;
      combined += chunk.data;
      if (combined.length > maxBytes * 2) {
        combined = combined.slice(-maxBytes);
      }
    }
    return combined.length > maxBytes ? combined.slice(-maxBytes) : combined;
  })();
}
