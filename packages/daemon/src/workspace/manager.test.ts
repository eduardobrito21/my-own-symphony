import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IssueIdentifier } from '../types/index.js';

import { WorkspaceManager, type WorkspaceLogger } from './manager.js';

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
      const mgr = new WorkspaceManager({ root });
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
      const mgr = new WorkspaceManager({ root });
      await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      const second = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.workspace.createdNow).toBe(false);
    });

    it('returns workspace_not_a_directory if the workspace path is a file', async () => {
      await writeFile(join(root, 'SYMP-1'), 'imposter');
      const mgr = new WorkspaceManager({ root });
      const result = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('workspace_not_a_directory');
    });

    it('sanitizes unsafe characters in the identifier', async () => {
      const mgr = new WorkspaceManager({ root });
      const result = await mgr.createForIssue(IssueIdentifier('weird/id with space'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.workspace.path).toBe(`${root}/weird_id_with_space`);
      }
    });

    it('handles concurrent calls for the same identifier idempotently', async () => {
      const mgr = new WorkspaceManager({ root });
      const [a, b] = await Promise.all([
        mgr.createForIssue(IssueIdentifier('SYMP-1')),
        mgr.createForIssue(IssueIdentifier('SYMP-1')),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) {
        const createdFlags = [a.workspace.createdNow, b.workspace.createdNow];
        expect(createdFlags.filter((x) => x)).toHaveLength(1);
      }
    });
  });

  describe('prepareForRun', () => {
    it('creates the workspace directory', async () => {
      const mgr = new WorkspaceManager({ root });
      const result = await mgr.prepareForRun(IssueIdentifier('SYMP-1'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((await stat(result.workspace.path)).isDirectory()).toBe(true);
      }
    });
  });

  describe('finalizeAfterRun', () => {
    it('is a no-op (post Plan 15)', async () => {
      const mgr = new WorkspaceManager({ root });
      const created = await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await expect(mgr.finalizeAfterRun(created.workspace)).resolves.toBeUndefined();
    });
  });

  describe('removeForTerminal', () => {
    it('removes the workspace directory but leaves the root untouched', async () => {
      const sentinel = join(root, '_external-sentinel-DO-NOT-DELETE.txt');
      await writeFile(sentinel, 'safe');
      const mgr = new WorkspaceManager({ root });
      await mgr.createForIssue(IssueIdentifier('SYMP-1'));
      await mgr.removeForTerminal(IssueIdentifier('SYMP-1'));
      let workspaceStillExists = false;
      try {
        await stat(`${root}/SYMP-1`);
        workspaceStillExists = true;
      } catch {
        workspaceStillExists = false;
      }
      expect(workspaceStillExists).toBe(false);
      const sentinelContent = await stat(sentinel);
      expect(sentinelContent.isFile()).toBe(true);
    });

    it('is a no-op for an issue with no existing workspace', async () => {
      const calls: { msg: string }[] = [];
      const logger: WorkspaceLogger = {
        warn(msg) {
          calls.push({ msg });
        },
        error(msg) {
          calls.push({ msg });
        },
      };
      const mgr = new WorkspaceManager({ root, logger });
      await expect(
        mgr.removeForTerminal(IssueIdentifier('NEVER-EXISTED')),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(0);
    });
  });
});
