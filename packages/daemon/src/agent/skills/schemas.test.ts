import { describe, expect, it } from 'vitest';

import {
  CoderResultSchema,
  CuratorResultSchema,
  parseCoderResult,
  parseCuratorResult,
  parseSandboxHandle,
  safeParseCoderResult,
  safeParseCuratorResult,
  safeParseSandboxHandle,
  SandboxHandleSchema,
} from './schemas.js';

describe('SandboxHandleSchema', () => {
  const validHandle = {
    id: 'symphony-eng-123',
    kind: 'local-docker',
    worktree_path: '/tmp/workspaces/eng-123',
    exec: {
      kind: 'shell-template' as const,
      template: 'docker compose -p symphony-eng-123 exec app {cmd}',
    },
    teardown: {
      kind: 'script' as const,
      script: 'docker compose -p symphony-eng-123 down -v',
    },
  };

  it('parses a valid SandboxHandle with all fields', () => {
    const result = SandboxHandleSchema.safeParse(validHandle);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('symphony-eng-123');
    expect(result.data.kind).toBe('local-docker');
    expect(result.data.exec.kind).toBe('shell-template');
    expect(result.data.teardown.kind).toBe('script');
  });

  it('parses a handle with deadline teardown', () => {
    const handle = {
      ...validHandle,
      teardown: {
        kind: 'deadline' as const,
        expires_at: '2026-05-17T12:00:00Z',
      },
    };
    const result = SandboxHandleSchema.safeParse(handle);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.teardown.kind).toBe('deadline');
    expect(result.data.teardown.expires_at).toBe('2026-05-17T12:00:00Z');
  });

  it('parses a handle with both deadline and script teardown', () => {
    const handle = {
      ...validHandle,
      teardown: {
        kind: 'both' as const,
        expires_at: '2026-05-17T12:00:00Z',
        script: 'cleanup.sh',
      },
    };
    const result = SandboxHandleSchema.safeParse(handle);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.teardown.kind).toBe('both');
  });

  it('rejects a handle missing required id field', () => {
    const { id: _, ...handleWithoutId } = validHandle;
    const result = SandboxHandleSchema.safeParse(handleWithoutId);
    expect(result.success).toBe(false);
  });

  it('rejects a handle with empty id', () => {
    const result = SandboxHandleSchema.safeParse({ ...validHandle, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a handle missing worktree_path', () => {
    const { worktree_path: _, ...handleWithoutPath } = validHandle;
    const result = SandboxHandleSchema.safeParse(handleWithoutPath);
    expect(result.success).toBe(false);
  });

  it('rejects a handle with invalid exec.kind', () => {
    const handle = {
      ...validHandle,
      exec: { kind: 'invalid', template: 'foo' },
    };
    const result = SandboxHandleSchema.safeParse(handle);
    expect(result.success).toBe(false);
  });

  it('rejects a handle with invalid teardown.kind', () => {
    const handle = {
      ...validHandle,
      teardown: { kind: 'invalid' },
    };
    const result = SandboxHandleSchema.safeParse(handle);
    expect(result.success).toBe(false);
  });

  it('rejects a handle with invalid expires_at datetime', () => {
    const handle = {
      ...validHandle,
      teardown: { kind: 'deadline', expires_at: 'not-a-datetime' },
    };
    const result = SandboxHandleSchema.safeParse(handle);
    expect(result.success).toBe(false);
  });

  describe('parseSandboxHandle', () => {
    it('returns the parsed handle on valid input', () => {
      const handle = parseSandboxHandle(validHandle);
      expect(handle.id).toBe('symphony-eng-123');
    });

    it('throws ZodError on invalid input', () => {
      expect(() => parseSandboxHandle({})).toThrow();
    });
  });

  describe('safeParseSandboxHandle', () => {
    it('returns success: true on valid input', () => {
      const result = safeParseSandboxHandle(validHandle);
      expect(result.success).toBe(true);
    });

    it('returns success: false on invalid input', () => {
      const result = safeParseSandboxHandle({});
      expect(result.success).toBe(false);
    });
  });
});

describe('CoderResultSchema', () => {
  it('parses a valid CoderResult with changed files', () => {
    const result = CoderResultSchema.safeParse({
      changed_files: ['src/index.ts', 'src/utils.ts'],
      summary: 'Updated imports',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.changed_files).toHaveLength(2);
    expect(result.data.summary).toBe('Updated imports');
  });

  it('parses a CoderResult with empty changed_files (stub case)', () => {
    const result = CoderResultSchema.safeParse({
      changed_files: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.changed_files).toHaveLength(0);
    expect(result.data.summary).toBeUndefined();
  });

  it('parses a CoderResult without optional summary', () => {
    const result = CoderResultSchema.safeParse({
      changed_files: ['README.md'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a CoderResult missing changed_files', () => {
    const result = CoderResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a CoderResult with non-array changed_files', () => {
    const result = CoderResultSchema.safeParse({
      changed_files: 'not-an-array',
    });
    expect(result.success).toBe(false);
  });

  describe('parseCoderResult', () => {
    it('returns the parsed result on valid input', () => {
      const result = parseCoderResult({ changed_files: ['a.ts'] });
      expect(result.changed_files).toEqual(['a.ts']);
    });

    it('throws ZodError on invalid input', () => {
      expect(() => parseCoderResult({})).toThrow();
    });
  });

  describe('safeParseCoderResult', () => {
    it('returns success: true on valid input', () => {
      const result = safeParseCoderResult({ changed_files: [] });
      expect(result.success).toBe(true);
    });

    it('returns success: false on invalid input', () => {
      const result = safeParseCoderResult({ changed_files: 123 });
      expect(result.success).toBe(false);
    });
  });
});

describe('CuratorResultSchema', () => {
  it('parses an audited result with auto_fixes and flags', () => {
    const result = CuratorResultSchema.safeParse({
      decision: 'audited',
      summary: 'Stamped one plan completed; flagged a stale cross-ref.',
      auto_fixes: ['docs/exec-plans/completed/22-foo.md'],
      flags: [
        {
          rule: 'cross-references',
          file: 'docs/PLANS.md',
          line: 47,
          concern: 'Reference to Plan 99 — no such plan.',
          suggested_fix: 'Remove the reference or correct the number.',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses a skipped result with empty arrays', () => {
    const result = CuratorResultSchema.safeParse({
      decision: 'skipped',
      summary: 'No harness-relevant files in changeset.',
      auto_fixes: [],
      flags: [],
    });
    expect(result.success).toBe(true);
  });

  it('allows a flag without a line number', () => {
    // `line` is best-effort — the curator omits it when it can't
    // pin a specific line.
    const result = CuratorResultSchema.safeParse({
      decision: 'audited',
      summary: 'One flag.',
      auto_fixes: [],
      flags: [
        {
          rule: 'index-parity',
          file: 'docs/design-docs/index.md',
          concern: 'Three docs missing from index.',
          suggested_fix: 'Add entries for foo.md, bar.md, baz.md.',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown decision value', () => {
    const result = CuratorResultSchema.safeParse({
      decision: 'maybe',
      summary: 'x',
      auto_fixes: [],
      flags: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a flag missing required fields', () => {
    const result = CuratorResultSchema.safeParse({
      decision: 'audited',
      summary: 'x',
      auto_fixes: [],
      flags: [
        { rule: 'x', file: 'y.md' }, // missing concern + suggested_fix
      ],
    });
    expect(result.success).toBe(false);
  });

  describe('parseCuratorResult', () => {
    it('returns the parsed result on valid input', () => {
      const result = parseCuratorResult({
        decision: 'skipped',
        summary: 'nothing to do',
        auto_fixes: [],
        flags: [],
      });
      expect(result.decision).toBe('skipped');
    });

    it('throws on invalid input', () => {
      expect(() => parseCuratorResult({})).toThrow();
    });
  });

  describe('safeParseCuratorResult', () => {
    it('returns success: true on valid input', () => {
      const result = safeParseCuratorResult({
        decision: 'audited',
        summary: 's',
        auto_fixes: [],
        flags: [],
      });
      expect(result.success).toBe(true);
    });

    it('returns success: false on invalid input', () => {
      const result = safeParseCuratorResult({ decision: 'audited' });
      expect(result.success).toBe(false);
    });
  });
});
