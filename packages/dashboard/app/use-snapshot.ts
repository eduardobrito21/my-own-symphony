'use client';

// Polls the daemon's `/api/v1/state` endpoint at a fixed interval
// and returns the latest snapshot (or an error). Keeps the
// dashboard's data-fetching logic in one place so individual
// panels can be presentation-only.

import { useEffect, useState } from 'react';

import type { StateSnapshotWire } from './api-types';

export interface UseSnapshotState {
  snapshot: StateSnapshotWire | null;
  /** Last fetch error, if the most recent attempt failed. */
  error: string | null;
  /** Wall-clock timestamp of the last successful fetch. */
  lastFetchedAt: Date | null;
}

const DEFAULT_INTERVAL_MS = 2_000;

export function useSnapshot(intervalMs: number = DEFAULT_INTERVAL_MS): UseSnapshotState {
  const [state, setState] = useState<UseSnapshotState>({
    snapshot: null,
    error: null,
    lastFetchedAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async (): Promise<void> => {
      try {
        const url = `${process.env.SYMPHONY_DAEMON_URL ?? 'http://127.0.0.1:3000'}/api/v1/state`;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
        const body = (await r.json()) as StateSnapshotWire;
        if (!cancelled) {
          setState({ snapshot: body, error: null, lastFetchedAt: new Date() });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            // Keep showing the last successful snapshot — better UX
            // than blanking the whole UI on a transient network blip.
            snapshot: prev.snapshot,
            error: err instanceof Error ? err.message : String(err),
            lastFetchedAt: prev.lastFetchedAt,
          }));
        }
      }
    };

    void fetchOnce();
    const handle = setInterval(() => {
      void fetchOnce();
    }, intervalMs);

    return (): void => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [intervalMs]);

  return state;
}
