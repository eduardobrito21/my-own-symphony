import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HooksConfig } from '../config/schema.js';
import { IssueIdentifier } from '../types/index.js';

import { WorkspaceManager, type WorkspaceLogger } from './manager.js';

function emptyHooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    timeout_ms: 5_000,
    ...overrides,
  };
}

function captureLogger(): WorkspaceLogger & {
  warns: { msg: string; fields?: Record<string, unknown> }[];
  errors: { msg: string; fields?: Record<string, unknown> }[];
} {
  const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
  const errors: { msg: string; fields?: Record<string, unknown> }[] = [];
  return {
    warn(msg, fields) {
      warns.push({ msg, fields });
    },
    error(msg, fields) {
      errors.push({ msg, fields });
    },
    warns,
    errors,
  };
}

describe('WorkspaceManager', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'symphony-ws-mgr-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('createForIssue', () => {
    it('creates the directory on first call (createdNow=true)', async () => {
      const mgr = new WorkspaceManager({ root, hooks: emptyHooks() });
      const result = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.workspace.createdNow).toBe(true);
        expect(result.workspace.path).toBe(`${root}/SYMP-1`);
        expect(result.workspace.key).toBe('SYMP-1');
        const info = await stat(result.workspace.path);
        expect(info.isDirectory()).toBe(true);
      }
    });

    it('reuses an existing directory on subsequent calls (createdNow=false)', async () => {
      const mgr = new WorkspaceManager({ root, hooks: emptyHooks() });
      await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      const second = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.workspace.createdNow).toBe(false);
    });

    it('runs after_create only when the directory is freshly created', async () => {
      const marker = join(root, 'SYMP-1', 'after-create-ran');
      const hooks = emptyHooks({
        after_create: `touch '${marker}'`,
      });
      const mgr = new WorkspaceManager({ root, hooks });
      await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      // First call: after_create should have created the marker.
      const firstStat = await stat(marker);
      expect(firstStat.isFile()).toBe(true);
      // Delete the marker and call again — it should NOT be recreated.
      await rm(marker);
      await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      let recreated = false;
      try {
        await stat(marker);
        recreated = true;
      } catch {
        recreated = false;
      }
      expect(recreated).toBe(false);
    });

    it('returns workspace_creation_failed when after_create exits non-zero', async () => {
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ after_create: 'exit 9' }),
      });
      const result = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('hook_non_zero_exit');
    });

    it('returns workspace_not_a_directory if the workspace path is a file', async () => {
      // Pre-place a file at the would-be workspace path.
      await writeFile(join(root, 'SYMP-1'), 'imposter');
      const mgr = new WorkspaceManager({ root, hooks: emptyHooks() });
      const result = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('workspace_not_a_directory');
    });

    it('sanitizes unsafe characters in the identifier', async () => {
      const mgr = new WorkspaceManager({ root, hooks: emptyHooks() });
      const result = await mgr.createForIssue(IssueIdentifier('weird/id with space'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.workspace.path).toBe(`${root}/weird_id_with_space`);
      }
    });

    it('handles concurrent calls for the same identifier idempotently', async () => {
      const mgr = new WorkspaceManager({ root, hooks: emptyHooks() });
      const [a, b] = await Promise.all([
        mgr.createForIssue(IssueIdentifier('SYMP-1')),
        mgr.createForIssue(IssueIdentifier('SYMP-1')),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) {
        // Exactly one of them sees createdNow=true. Either ordering
        // is fine; they raced the mkdir.
        const createdFlags = [a.workspace.createdNow, b.workspace.createdNow];
        expect(createdFlags.filter((x) => x)).toHaveLength(1);
      }
    });
  });

  describe('prepareForRun', () => {
    it('runs before_run after creation', async () => {
      const marker = join(root, 'SYMP-1', 'before-run.txt');
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ before_run: `printf ran > '${marker}'` }),
      });
      const result = await mgr.prepareForRun(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(true);
      expect(await readFile(marker, 'utf8')).toBe('ran');
    });

    it('fails the attempt when before_run fails', async () => {
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ before_run: 'exit 3' }),
      });
      const result = await mgr.prepareForRun(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('hook_non_zero_exit');
    });
  });

  describe('finalizeAfterRun', () => {
    it('runs after_run on success path', async () => {
      const marker = join(root, 'SYMP-1', 'after-run.txt');
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ after_run: `printf ok > '${marker}'` }),
      });
      const created = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await mgr.finalizeAfterRun(created.workspace);
      expect(await readFile(marker, 'utf8')).toBe('ok');
    });

    it('logs and swallows after_run failures (does not throw)', async () => {
      const logger = captureLogger();
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ after_run: 'exit 1' }),
        logger,
      });
      const created = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await expect(mgr.finalizeAfterRun(created.workspace)).resolves.toBeUndefined();
      expect(logger.warns.some((w) => w.msg.includes('after_run'))).toBe(true);
    });
  });

  describe('removeForTerminal', () => {
    it('removes the workspace directory and runs before_remove', async () => {
      const sentinel = join(root, '_external-sentinel-DO-NOT-DELETE.txt');
      await writeFile(sentinel, 'safe');
      const beforeRemoveTouched = join(root, '_before-remove-marker');
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ before_remove: `touch '${beforeRemoveTouched}'` }),
      });
      const created = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(created.ok).toBe(true);
      await mgr.removeForTerminal(IssueIdentifier('SYMP-1'));
      // The workspace itself should be gone.
      let workspaceStillExists = false;
      try {
        await stat(`${root}/SYMP-1`);
        workspaceStillExists = true;
      } catch {
        workspaceStillExists = false;
      }
      expect(workspaceStillExists).toBe(false);
      // The before_remove hook should have run before deletion.
      expect((await stat(beforeRemoveTouched)).isFile()).toBe(true);
      // Sibling sentinel must be untouched (root not nuked).
      expect(await readFile(sentinel, 'utf8')).toBe('safe');
    });

    it('proceeds with deletion when before_remove fails (best effort)', async () => {
      const logger = captureLogger();
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ before_remove: 'exit 5' }),
        logger,
      });
      await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      await mgr.removeForTerminal(IssueIdentifier('SYMP-1'));
      let exists = false;
      try {
        await stat(`${root}/SYMP-1`);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
      expect(logger.warns.some((w) => w.msg.includes('before_remove'))).toBe(true);
    });

    it('is a no-op for an issue with no existing workspace', async () => {
      const logger = captureLogger();
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ before_remove: 'echo should-not-run' }),
        logger,
      });
      await expect(
        mgr.removeForTerminal(IssueIdentifier('NEVER-EXISTED')),
      ).resolves.toBeUndefined();
      // No errors logged because we short-circuited before any hook.
      expect(logger.errors).toHaveLength(0);
    });
  });

  describe('logger injection', () => {
    it('falls back to a no-op logger when none is provided', async () => {
      // Just verify nothing throws when failures fire on the default
      // logger. (No assertion on calls — they're discarded.)
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ after_run: 'exit 1' }),
      });
      const created = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await expect(mgr.finalizeAfterRun(created.workspace)).resolves.toBeUndefined();
    });

    it('passes the failure error through the logger fields', async () => {
      // We capture into a plain array (rather than `vi.fn()`) so the
      // strict-typed-eslint rules can see what's stored at each call.
      const calls: { msg: string; fields?: Record<string, unknown> }[] = [];
      const logger: WorkspaceLogger = {
        warn(msg, fields) {
          calls.push({ msg, fields });
        },
        error() {
          /* not asserting on error path */
        },
      };
      const mgr = new WorkspaceManager({
        root,
        hooks: emptyHooks({ after_run: 'exit 7' }),
        logger,
      });
      const created = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      if (!created.ok) return;
      await mgr.finalizeAfterRun(created.workspace);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.msg).toContain('after_run');
      expect(calls[0]?.fields).toMatchObject({
        error: { code: 'hook_non_zero_exit' },
      });
    });
  });
});
