// Host-side daemon ↔ pod event channel.
//
// Plan 10 stage 11d originally specified a per-pod **Unix domain
// socket** bind-mounted into the container. That works on native
// Linux but breaks on Docker Desktop for macOS — VirtioFS does not
// pass live AF_UNIX sockets through bind mounts; the file appears in
// the pod but `connect()` fails with `EACCES` (verified 2026-04-30
// in the smoke run).
//
// Decision (2026-04-30): use a per-pod **TCP loopback socket** on
// `127.0.0.1:<random-port>` instead. The pod connects via
// `host.docker.internal:<port>` (we wire `--add-host=host.docker.internal:host-gateway`
// in the docker run args so the name resolves on Linux too). Same
// JSON-line `AgentEvent` wire format; only the transport changed.
//
// Tradeoffs vs Unix sockets:
//   + Works on every host the docker CLI works on.
//   + Trivial to inspect with `nc 127.0.0.1 <port>`.
//   - Tiny port-allocation overhead (`listen(0)` picks a free port).
//   - Bound to loopback only; never publicly exposed.
//
// Per ADR 0011 + Plan 10, each line is one `AgentEvent`. We parse +
// validate via zod (ADR 0006) before yielding. Date fields come back
// as ISO strings; we revive them into `Date` instances on the way out.
//
// The reader's lifecycle:
//
//   - `bindEventSocket()` opens a TCP listener on 127.0.0.1:0 and
//     returns a handle whose `port` is the bound port.
//   - `events()` returns an `AsyncIterable<AgentEvent>` that yields as
//     the pod writes. Iteration ends when:
//       a) the pod emits a terminal event (turn_completed /
//          turn_failed), OR
//       b) the pod's socket end closes (EOF), OR
//       c) the abort signal fires.
//   - `close()` shuts the listener down. Idempotent.
//
// One reader == one pod. The daemon allocates one per dispatch.

import { createServer, type Server, type Socket } from 'node:net';
import { z } from 'zod';

import type { AgentEvent } from '../../agent/runner.js';

// Wire schema. Mirrors the AgentEvent union in `agent/runner.ts` —
// but with `at` as an ISO string (JSON.stringify always serializes
// Date that way). We revive into Date on the way out.
//
// We define a permissive shape rather than a strict discriminated
// union to keep additive event-kind changes (per the runner's
// "additive only" contract) from breaking existing pods. Unknown
// kinds parse as a generic `notification` — they still flow to the
// daemon, just without specialized handling.
const WireEventBaseSchema = z
  .object({
    kind: z.string().min(1),
    at: z.string().datetime({ offset: true }),
  })
  .passthrough();

export interface SocketServerArgs {
  /** Cancellation. When aborted, iteration ends and the listener closes. */
  readonly signal?: AbortSignal;
}

/**
 * Allocate + bind a TCP listener on 127.0.0.1:0 (random free port).
 * Returns a handle whose `events()` is the `AsyncIterable<AgentEvent>`
 * the daemon iterates and whose `close()` tears the listener down.
 *
 * Resolves only after `listen` reports ready, so the next step
 * (starting the docker container) can be sure the port is open when
 * the pod tries to connect.
 */
export async function bindEventSocket(args: SocketServerArgs = {}): Promise<EventSocketServer> {
  const server = createServer();
  const conn = await waitForConnection(server, args.signal);
  return new EventSocketServer(server, conn);
}

interface PendingConn {
  readonly socket: Socket | null;
  readonly closed: boolean;
}

function waitForConnection(
  server: Server,
  signal: AbortSignal | undefined,
): Promise<{ port: number; accept(): Promise<Socket | null> }> {
  return new Promise((resolveBind, rejectBind) => {
    let acceptResolve: ((s: Socket | null) => void) | null = null;
    let pending: PendingConn = { socket: null, closed: false };

    const accept = (): Promise<Socket | null> => {
      if (pending.socket !== null) {
        const s = pending.socket;
        pending = { socket: null, closed: pending.closed };
        return Promise.resolve(s);
      }
      if (pending.closed) return Promise.resolve(null);
      return new Promise<Socket | null>((r) => {
        acceptResolve = r;
      });
    };

    server.on('connection', (s) => {
      if (acceptResolve !== null) {
        const r = acceptResolve;
        acceptResolve = null;
        r(s);
      } else {
        pending = { socket: s, closed: false };
      }
    });
    server.on('error', (cause) => {
      rejectBind(cause);
    });
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        rejectBind(new Error(`listen() returned unexpected address: ${String(addr)}`));
        return;
      }
      const { port } = addr;
      resolveBind({ port, accept });
    });

    if (signal !== undefined) {
      const onAbort = (): void => {
        pending = { socket: null, closed: true };
        if (acceptResolve !== null) {
          const r = acceptResolve;
          acceptResolve = null;
          r(null);
        }
        server.close();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

export class EventSocketServer {
  private closed = false;
  private acceptedSocket: Socket | null = null;
  /** Bound TCP port on 127.0.0.1. The daemon passes
   *  `host.docker.internal:<port>` to the pod via env var. */
  readonly port: number;

  constructor(
    private readonly server: Server,
    private readonly accepter: { port: number; accept(): Promise<Socket | null> },
  ) {
    this.port = accepter.port;
  }

  /**
   * AsyncIterable that yields parsed `AgentEvent`s. Generator-style
   * so consumers can `for await ... break` to abort.
   *
   * Terminates when the pod closes its end (EOF) OR when a terminal
   * event is yielded OR when the abort signal fires (we surface this
   * by closing the underlying socket).
   */
  events(): AsyncIterable<AgentEvent> {
    // Capture only the bits the iterator needs — `accepter` for the
    // pending connection, and a callback for setting the back-reference
    // we use during `close()`. This avoids aliasing `this` (banned by
    // `@typescript-eslint/no-this-alias`) inside the generator.
    const accepter = this.accepter;
    const setSocket = (s: Socket): void => {
      this.acceptedSocket = s;
    };
    return {
      async *[Symbol.asyncIterator]() {
        const socket = await accepter.accept();
        if (socket === null) return;
        setSocket(socket);
        // Decoder for chunked reads. Lines may straddle chunk
        // boundaries; we buffer until a newline.
        let buffer = '';
        try {
          for await (const chunk of socket) {
            buffer += (chunk as Buffer).toString('utf8');
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
          // Flush any final partial line that didn't end in \n.
          const trailing = buffer.trim();
          if (trailing.length > 0) {
            const event = parseLine(trailing);
            if (event !== null) yield event;
          }
        } finally {
          socket.destroy();
        }
      },
    };
  }

  /** Shut the TCP listener down. Safe to call multiple times. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.acceptedSocket?.destroy();
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
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
  // Revive `Date`. Cast through unknown — the AgentEvent union has
  // strict shapes per kind that we don't validate exhaustively here;
  // the daemon's consumer treats unknown kinds as no-ops.
  return { ...data, at: new Date(data.at) } as unknown as AgentEvent;
}
