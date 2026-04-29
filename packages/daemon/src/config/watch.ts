// `WORKFLOW.md` file watcher per SPEC §6.2.
//
// Uses `chokidar` rather than `node:fs.watch` because:
//   - Editors that do atomic-write rename (vim's default, sed -i,
//     macOS TextEdit) fire weird event sequences on plain fs.watch.
//     chokidar normalizes them.
//   - chokidar handles "the watched file was deleted and recreated"
//     gracefully; raw fs.watch silently stops watching.
//
// Reload flow:
//   1. chokidar emits a change/add event.
//   2. We debounce (300 ms default) — most editors fire 2-5 events
//      per save and we want one reload.
//   3. We call `loadWorkflow` again. If it succeeds, we hand the
//      new `WorkflowDefinition` to `onReload`. If it fails, we hand
//      the typed error to `onError` and keep the previous config.
//   4. The orchestrator's `applyWorkflow` is the typical onReload
//      handler — it swaps live config in place.

import { watch, type FSWatcher } from 'chokidar';

import type { WorkflowError } from './errors.js';
import { loadWorkflow } from './loader.js';
import type { WorkflowDefinition } from './schema.js';

export interface WorkflowWatcherArgs {
  readonly path: string;
  readonly onReload: (def: WorkflowDefinition) => void | Promise<void>;
  readonly onError: (err: WorkflowError) => void;
  /** Default 300 ms. Lower in tests so they don't wait. */
  readonly debounceMs?: number;
  /**
   * Override the reload function in tests. Default is the real
   * `loadWorkflow` from `loader.ts`.
   */
  readonly load?: typeof loadWorkflow;
}

/**
 * A lightweight wrapper around chokidar that debounces events and
 * routes results to the configured callbacks. The watcher starts
 * watching as soon as it's constructed; close it via `close()`.
 */
export class WorkflowWatcher {
  private readonly watcher: FSWatcher;
  private readonly path: string;
  private readonly onReload: WorkflowWatcherArgs['onReload'];
  private readonly onError: WorkflowWatcherArgs['onError'];
  private readonly debounceMs: number;
  private readonly load: typeof loadWorkflow;
  private debounceTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(args: WorkflowWatcherArgs) {
    this.path = args.path;
    this.onReload = args.onReload;
    this.onError = args.onError;
    this.debounceMs = args.debounceMs ?? 300;
    this.load = args.load ?? loadWorkflow;

    this.watcher = watch(this.path, {
      // We don't want a "synthetic add" event right after construction;
      // the orchestrator already loaded the workflow once at startup.
      ignoreInitial: true,
      // Don't follow into git/node_modules even if the path resolves
      // weirdly; the watcher only watches the single file anyway,
      // but be paranoid.
      ignored: ['**/node_modules/**', '**/.git/**'],
    });

    // chokidar emits 'change' for content changes and 'add' for
    // recreations (when an editor does atomic-write rename, the file
    // briefly disappears and reappears). Treat both as a reload signal.
    this.watcher.on('change', () => {
      this.scheduleReload();
    });
    this.watcher.on('add', () => {
      this.scheduleReload();
    });
  }

  /**
   * Stop watching. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.watcher.close();
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reload();
    }, this.debounceMs);
  }

  private async reload(): Promise<void> {
    if (this.closed) return;
    const result = await this.load(this.path);
    // ESLint's type-narrowing thinks `this.closed` is still `false`
    // here — but `close()` may have flipped it during the await.
    // The runtime check is real; suppress the static one.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.closed) return;
    if (!result.ok) {
      this.onError(result.error);
      return;
    }
    await this.onReload(result.value);
  }
}
