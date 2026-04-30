// JSON-line writer for the daemon ↔ pod event protocol.
//
// Per ADR 0011 + Plan 10 stage 11d: each `AgentEvent` the in-pod
// runner emits is serialized as one JSON line and written to a TCP
// socket on the host. The daemon-side `LocalDockerBackend` listens on
// `127.0.0.1:<random-port>` and the pod connects via
// `host.docker.internal:<port>`.
//
// (The original Plan 10 design used a Unix domain socket bind-mounted
// into the pod. That broke on Docker Desktop for macOS — VirtioFS
// does not pass live AF_UNIX sockets through bind mounts. Switched to
// TCP loopback in the 2026-04-30 refactor; documented in
// `LocalDockerBackend`'s socket-server comment.)
//
// Why JSON lines (not framed protobuf, msgpack, etc.):
//   - Same shape we already serialize for the HTTP wire (Plan 08).
//   - Easy to inspect by hand: `nc 127.0.0.1 <port> | jq` while
//     debugging a stuck pod.
//   - The agent emits at human speeds (low tens of events/sec, peak),
//     well below socket buffer limits — backpressure is trivial.
//
// `Date` fields on `AgentEvent` serialize to ISO strings via the
// default `JSON.stringify` path. The host-side reader parses them
// back into `Date` objects. We do not depend on any custom serializer
// because the shape is small and stable.

import { createConnection, type Socket } from 'node:net';

import type { AgentEvent } from '@symphony/daemon/agent/runner';

export interface SocketWriterArgs {
  /** TCP host the daemon listens on. From the pod, this is typically
   *  `host.docker.internal`. */
  readonly host: string;
  /** TCP port the daemon's listener bound to (random-per-pod). */
  readonly port: number;
  /** Connection timeout in ms. Default 5_000. */
  readonly connectTimeoutMs?: number;
}

/**
 * Connect to the daemon's event socket and return a writer with
 * `write(event)` + `close()`. Connection is established eagerly so
 * the entrypoint surfaces a "daemon socket unreachable" error
 * immediately rather than after the agent has done work.
 */
export async function connectEventSocket(args: SocketWriterArgs): Promise<EventSocketWriter> {
  const socket = await openSocket(args.host, args.port, args.connectTimeoutMs ?? 5_000);
  return new EventSocketWriter(socket);
}

export class EventSocketWriter {
  private closed = false;

  constructor(private readonly socket: Socket) {}

  /**
   * Serialize an event and write one JSON line. Returns a promise
   * that resolves when the bytes have been flushed to the socket
   * buffer (NOT when the host has consumed them — sockets give you
   * no such signal). `await`-ing here keeps backpressure honest if
   * the daemon is briefly slow to drain.
   */
  write(event: AgentEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('EventSocketWriter is closed'));
    }
    const line = `${JSON.stringify(event)}\n`;
    return new Promise<void>((resolve, reject) => {
      const ok = this.socket.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (!ok) {
        // Buffer is full; wait for drain before resolving. This is
        // the textbook backpressure path for a Node `Writable`.
        this.socket.once('drain', () => {
          resolve();
        });
      }
    });
  }

  /**
   * Half-close the writer side. The host-side reader sees EOF and
   * terminates its iteration. Safe to call repeatedly.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise<void>((resolve) => {
      this.socket.end(() => {
        resolve();
      });
    });
  }
}

function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port} after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

/**
 * Parse a `host:port` string (the format the daemon passes via the
 * `SYMPHONY_EVENT_HOST` env var). Returns `null` on malformed input
 * — the entrypoint surfaces that as a `turn_failed` event.
 */
export function parseEventHost(raw: string): { host: string; port: number } | null {
  const idx = raw.lastIndexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const host = raw.slice(0, idx);
  const port = Number.parseInt(raw.slice(idx + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null;
  return { host, port };
}
