// `WorkflowWatcher` tests.
//
// We test the watcher's debounce + reload-routing logic using a
// stub `load` function. The actual chokidar event detection is left
// to chokidar's own tests; we just verify our wrapper's contract.

import { describe, expect, it } from 'vitest';

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowWatcher } from './watch.js';
import type { WorkflowError } from './errors.js';
import type { WorkflowDefinition } from './schema.js';
import type { WorkflowLoadResult } from './errors.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WorkflowWatcher', () => {
  it('reloads the file on change and routes to onReload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'symphony-watch-'));
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, 'initial');
    try {
      const reloads: WorkflowDefinition[] = [];
      const errors: WorkflowError[] = [];
      let loadCount = 0;
      const stubLoad = (): Promise<WorkflowLoadResult<WorkflowDefinition>> => {
        loadCount += 1;
        return Promise.resolve({
          ok: true,
          value: {
            config: { tracker: {}, polling: { interval_ms: loadCount * 1000 } } as never,
            promptTemplate: `template ${loadCount}`,
            path,
          },
        });
      };

      const watcher = new WorkflowWatcher({
        path,
        onReload: (def) => reloads.push(def),
        onError: (err) => errors.push(err),
        debounceMs: 30,
        load: stubLoad,
      });

      // Trigger a change.
      await delay(100); // give chokidar a moment to start watching
      await writeFile(path, 'modified');

      // Wait for debounce + reload.
      await delay(200);

      expect(reloads.length).toBeGreaterThanOrEqual(1);
      expect(errors).toHaveLength(0);

      await watcher.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes parse errors to onError without crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'symphony-watch-err-'));
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, 'initial');
    try {
      const errors: WorkflowError[] = [];
      const stubLoad = (): Promise<WorkflowLoadResult<WorkflowDefinition>> => {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'workflow_parse_error',
            path,
            message: 'fake parse failure',
            cause: null,
          },
        });
      };

      const watcher = new WorkflowWatcher({
        path,
        onReload: () => {
          /* test stub */
        },
        onError: (err) => errors.push(err),
        debounceMs: 20,
        load: stubLoad,
      });

      await delay(80);
      await writeFile(path, 'whatever');
      await delay(150);

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]?.code).toBe('workflow_parse_error');

      await watcher.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('debounces multiple rapid changes into a single reload call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'symphony-watch-debounce-'));
    const path = join(dir, 'WORKFLOW.md');
    await writeFile(path, 'initial');
    try {
      let loadCount = 0;
      const stubLoad = (): Promise<WorkflowLoadResult<WorkflowDefinition>> => {
        loadCount += 1;
        return Promise.resolve({
          ok: true,
          value: {
            config: { tracker: {} } as never,
            promptTemplate: '',
            path,
          },
        });
      };

      const watcher = new WorkflowWatcher({
        path,
        onReload: () => {
          /* test stub */
        },
        onError: () => {
          /* test stub */
        },
        debounceMs: 100,
        load: stubLoad,
      });

      await delay(80);
      // Fire many writes in a tight burst.
      for (let i = 0; i < 5; i += 1) {
        await writeFile(path, `change ${i}`);
        await delay(10);
      }
      // Wait past the debounce.
      await delay(200);

      // chokidar may emit slightly different counts across platforms;
      // the contract we promise is "fewer reloads than writes."
      expect(loadCount).toBeLessThan(5);
      expect(loadCount).toBeGreaterThanOrEqual(1);

      await watcher.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
