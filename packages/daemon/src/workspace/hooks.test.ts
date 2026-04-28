import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';

/**
 * These are integration tests: they spawn `bash` for real. The tests
 * require a POSIX-ish environment (macOS or Linux) — they would not
 * pass on Windows. We do not claim Windows support.
 */
describe('runHook', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'symphony-hooks-test-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns success and captures stdout for a passing hook', async () => {
    const result = await runHook({
      name: 'after_create',
      script: 'echo hello-stdout',
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.trim()).toBe('hello-stdout');
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runHook({
      name: 'before_run',
      script: 'echo to-stdout; echo to-stderr 1>&2',
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toContain('to-stdout');
      expect(result.stderr).toContain('to-stderr');
    }
  });

  it('runs the script with the configured cwd', async () => {
    const result = await runHook({
      name: 'after_create',
      script: 'pwd',
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // macOS resolves /var/folders/... -> /private/var/folders/...
      // when bash reads PWD, so accept either the input or /private prefix.
      const trimmed = result.stdout.trim();
      expect([cwd, `/private${cwd}`]).toContain(trimmed);
    }
  });

  it('observes filesystem side effects from the script', async () => {
    const target = join(cwd, 'created-by-hook.txt');
    const result = await runHook({
      name: 'after_create',
      script: `printf 'persisted' > '${target}'`,
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('persisted');
  });

  it('returns a hook_non_zero_exit error for a script that exits non-zero', async () => {
    const result = await runHook({
      name: 'before_run',
      script: 'echo before-fail; exit 17',
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('hook_non_zero_exit');
      if (result.error.code === 'hook_non_zero_exit') {
        expect(result.error.exitCode).toBe(17);
        expect(result.error.stdoutTail).toContain('before-fail');
      }
    }
  });

  it('returns a hook_timeout error when the script exceeds the timeout', async () => {
    const start = Date.now();
    const result = await runHook({
      name: 'after_run',
      script: 'sleep 5',
      cwd,
      timeoutMs: 200,
      gracePeriodMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hook_timeout');
    // Should NOT have taken anywhere close to the full 5 seconds —
    // we kill the child within timeoutMs + gracePeriodMs (~400ms)
    // plus some slack for spawn overhead.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('returns success immediately for an empty script (no spawn)', async () => {
    const result = await runHook({
      name: 'after_create',
      script: '   \n  ',
      cwd,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The empty-script short-circuit reports zero duration.
      expect(result.durationMs).toBe(0);
    }
  });

  it('truncates very large stdout to avoid blowing up daemon memory', async () => {
    // Generate ~1MB of output with the configured cap of 8KB.
    const result = await runHook({
      name: 'after_create',
      script: "yes 'x' | head -c 1048576",
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toContain('[truncated]');
      // 8KB cap plus the truncation marker.
      expect(result.stdout.length).toBeLessThan(9 * 1024);
    }
  });
});
