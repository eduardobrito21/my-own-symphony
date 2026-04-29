// Minimal HTTP server for the daemon's read-only state endpoint.
//
// Plan 08a: a tiny surface (`/api/v1/health`, `/api/v1/state`) for
// the dashboard (Plan 08b) and `curl`-based debugging. Read-only
// for v1; no mutations, no auth, loopback by default.
//
// We use Node's built-in `http` module — no Fastify dependency.
// Two endpoints don't justify a framework, and avoiding the dep
// means the daemon stays small and easy to ship.
//
// CORS: `Access-Control-Allow-Origin: *` is fine because (a) the
// server binds loopback (`127.0.0.1`) by default so external
// origins can't reach it anyway, and (b) the dashboard runs on a
// different port (Next.js dev server) and would otherwise hit a
// cross-origin block.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import type { Logger } from '../observability/index.js';
import type { OrchestratorState } from '../types/index.js';

import { serializeState } from './serialize.js';

export interface HttpServerArgs {
  /** Port to listen on. Pass `0` to let the OS pick (used in tests). */
  readonly port: number;
  /** Bind host. Defaults to `127.0.0.1` (loopback). */
  readonly host?: string;
  /** Snapshot accessor. Called per request — keep it cheap. */
  readonly getSnapshot: () => OrchestratorState;
  /** Wall clock for the response (`now` field). Injectable for tests. */
  readonly now?: () => Date;
  /** Monotonic clock for retry-due computation. Injectable for tests. */
  readonly monotonicNow?: () => number;
  /** When the daemon process started. Used for uptime / debugging. */
  readonly daemonStartedAt: Date;
  readonly logger: Logger;
}

export interface RunningHttpServer {
  /** Actual port the server is listening on (matters when port=0). */
  readonly port: number;
  readonly server: Server;
  /** Stop accepting new connections + wait for active requests. */
  close(): Promise<void>;
}

/** Default CORS headers — read-only API on loopback, allow everything. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function startHttpServer(args: HttpServerArgs): Promise<RunningHttpServer> {
  const host = args.host ?? '127.0.0.1';
  const now = args.now ?? (() => new Date());
  const monotonicNow = args.monotonicNow ?? (() => performance.now());
  const log = args.logger.with({ component: 'http' });

  const server = createServer((req, res) => {
    handleRequest({
      req,
      res,
      getSnapshot: args.getSnapshot,
      now,
      monotonicNow,
      daemonStartedAt: args.daemonStartedAt,
      log,
    });
  });

  return new Promise<RunningHttpServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : args.port;
      log.info('http server listening', { host, port: actualPort });
      server.removeListener('error', reject);
      resolve({
        port: actualPort,
        server,
        close: () =>
          new Promise<void>((r, j) => {
            server.close((err) => {
              if (err === undefined) {
                r();
                return;
              }
              j(err);
            });
          }),
      });
    });
  });
}

interface HandleArgs {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly getSnapshot: () => OrchestratorState;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly daemonStartedAt: Date;
  readonly log: Logger;
}

function handleRequest(args: HandleArgs): void {
  const { req, res } = args;
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // CORS preflight: dashboard hits us from a different port in dev.
  if (method === 'OPTIONS') {
    writeJson(res, 204, null);
    return;
  }

  if (method !== 'GET') {
    writeJson(res, 405, { error: { code: 'method_not_allowed', message: `Method ${method}` } });
    return;
  }

  // Trim query string. We don't use any query params yet.
  const path = url.split('?')[0] ?? '/';

  if (path === '/api/v1/health') {
    writeJson(res, 200, { status: 'ok' });
    return;
  }

  if (path === '/api/v1/state') {
    let payload;
    try {
      payload = serializeState({
        state: args.getSnapshot(),
        now: args.now(),
        daemonStartedAt: args.daemonStartedAt,
        monotonicNowMs: args.monotonicNow(),
      });
    } catch (cause) {
      args.log.error('snapshot serialization failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      writeJson(res, 500, {
        error: { code: 'snapshot_failed', message: 'Failed to serialize state.' },
      });
      return;
    }
    writeJson(res, 200, payload);
    return;
  }

  writeJson(res, 404, {
    error: { code: 'not_found', message: `No route for ${method} ${path}` },
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }
  if (body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
