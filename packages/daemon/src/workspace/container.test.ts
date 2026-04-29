// Unit tests for `WorkspaceContainer` with a mocked docker runner.
//
// We don't boot real Docker here. The DockerRunner injection point
// is exactly the kind of seam these tests are for: assert that we
// invoke `docker` with the right argv for each lifecycle event.

import { describe, expect, it, vi } from 'vitest';

import { NULL_LOGGER } from '../observability/index.js';

import {
  WorkspaceContainer,
  type DockerResult,
  type DockerRunner,
  type WorkspaceContainerArgs,
} from './container.js';

const OK = (stdout = '', stderr = ''): DockerResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr,
});

const FAIL = (stderr = 'no such container', exitCode = 1): DockerResult => ({
  ok: false,
  exitCode,
  stdout: '',
  stderr,
  signal: null,
});

function makeContainer(
  runDocker: DockerRunner,
  overrides: Partial<WorkspaceContainerArgs> = {},
): WorkspaceContainer {
  return new WorkspaceContainer({
    key: 'EDU-5',
    workspacePath: '/host/workspaces/EDU-5',
    logger: NULL_LOGGER,
    runDocker,
    ...overrides,
  });
}

describe('WorkspaceContainer.name', () => {
  it('prefixes the sanitized key with `symphony-`', () => {
    const c = makeContainer(vi.fn());
    expect(c.name).toBe('symphony-EDU-5');
  });
});

describe('WorkspaceContainer.ensureRunning', () => {
  it('runs `docker run -d` when the container is missing', async () => {
    const calls: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      calls.push(args);
      // First call: `docker inspect` fails (no such container).
      if (args[0] === 'inspect') return Promise.resolve(FAIL());
      // Second call: `docker run` succeeds.
      return Promise.resolve(OK('container-id-123\n'));
    };

    const c = makeContainer(runDocker);
    const result = await c.ensureRunning();
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['inspect', '--format={{.State.Running}}', 'symphony-EDU-5']);
    expect(calls[1]?.[0]).toBe('run');
    expect(calls[1]).toContain('--name');
    expect(calls[1]).toContain('symphony-EDU-5');
    expect(calls[1]).toContain('-v');
    expect(calls[1]).toContain('/host/workspaces/EDU-5:/workspace');
    expect(calls[1]).toContain('-w');
    expect(calls[1]).toContain('/workspace');
  });

  it('uses `docker start` when the container exists but is stopped', async () => {
    const calls: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      calls.push(args);
      if (args[0] === 'inspect') return Promise.resolve(OK('false\n'));
      return Promise.resolve(OK());
    };

    const c = makeContainer(runDocker);
    await c.ensureRunning();
    expect(calls.map((a) => a[0])).toEqual(['inspect', 'start']);
    expect(calls[1]).toEqual(['start', 'symphony-EDU-5']);
  });

  it('is a no-op when the container is already running', async () => {
    const calls: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      calls.push(args);
      return Promise.resolve(OK('true\n'));
    };

    const c = makeContainer(runDocker);
    await c.ensureRunning();
    expect(calls.map((a) => a[0])).toEqual(['inspect']);
  });

  it('forwards env vars to `docker run`', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      if (args[0] === 'inspect') return Promise.resolve(FAIL());
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker, {
      env: { GITHUB_TOKEN: 'gh-secret', TARGET_REPO_URL: 'https://github.com/foo/bar.git' },
    });
    await c.ensureRunning();
    const runArgs = seen[1] ?? [];
    expect(runArgs).toContain('GITHUB_TOKEN=gh-secret');
    expect(runArgs).toContain('TARGET_REPO_URL=https://github.com/foo/bar.git');
  });

  it('runs as uid:gid 1000:1000 by default (matches the agent image user)', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      if (args[0] === 'inspect') return Promise.resolve(FAIL());
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker);
    await c.ensureRunning();
    const runArgs = seen[1] ?? [];
    const userIdx = runArgs.indexOf('--user');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(runArgs[userIdx + 1]).toBe('1000:1000');
  });

  it('honors a custom uid:gid override', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      if (args[0] === 'inspect') return Promise.resolve(FAIL());
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker, { user: '501:20' });
    await c.ensureRunning();
    const runArgs = seen[1] ?? [];
    const userIdx = runArgs.indexOf('--user');
    expect(runArgs[userIdx + 1]).toBe('501:20');
  });
});

describe('WorkspaceContainer.exec', () => {
  it('builds the right `docker exec` argv', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      return Promise.resolve(OK('hello\n'));
    };
    const c = makeContainer(runDocker);
    const result = await c.exec('git', ['status', '--short']);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(['exec', 'symphony-EDU-5', 'git', 'status', '--short']);
  });

  it('passes env via `--env` flags when provided', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker);
    await c.exec('node', ['-e', '1+1'], { env: { FOO: 'bar', BAZ: 'qux' } });
    const argv = seen[0] ?? [];
    expect(argv).toContain('--env');
    expect(argv).toContain('FOO=bar');
    expect(argv).toContain('BAZ=qux');
  });

  it('adds `-i` when stdin is provided', async () => {
    const seen: { args: readonly string[]; opts: unknown }[] = [];
    const runDocker: DockerRunner = (args, options) => {
      seen.push({ args, opts: options });
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker);
    await c.exec('cat', [], { stdin: 'piped data' });
    expect(seen[0]?.args).toContain('-i');
    expect(seen[0]?.opts).toEqual({ stdin: 'piped data' });
  });

  it('returns a non-ok DockerResult when the command exits non-zero', async () => {
    const runDocker: DockerRunner = () =>
      Promise.resolve({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repository',
        signal: null,
      });
    const c = makeContainer(runDocker);
    const result = await c.exec('git', ['status']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not a git repository/);
    }
  });
});

describe('WorkspaceContainer.destroy', () => {
  it('runs `docker rm -f`', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker);
    await c.destroy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(['rm', '-f', 'symphony-EDU-5']);
  });

  it('does not throw when removal fails (best-effort cleanup)', async () => {
    const runDocker: DockerRunner = () => Promise.resolve(FAIL('Error response from daemon'));
    const c = makeContainer(runDocker);
    await expect(c.destroy()).resolves.toBeUndefined();
  });
});

describe('WorkspaceContainer — image override', () => {
  it('uses the supplied image name in `docker run`', async () => {
    const seen: (readonly string[])[] = [];
    const runDocker: DockerRunner = (args) => {
      seen.push(args);
      if (args[0] === 'inspect') return Promise.resolve(FAIL());
      return Promise.resolve(OK());
    };
    const c = makeContainer(runDocker, { image: 'my/agent:custom' });
    await c.ensureRunning();
    const runArgs = seen[1] ?? [];
    // The image is the LAST positional arg (after all flags).
    expect(runArgs.at(-1)).toBe('my/agent:custom');
  });
});
