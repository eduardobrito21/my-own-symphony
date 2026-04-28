import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixture } from './fixture-loader.js';

describe('loadFixture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'symphony-fixture-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns fixture_not_found for a missing file', async () => {
    const result = await loadFixture(join(dir, 'nope.yaml'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('fixture_not_found');
  });

  it('loads a minimal valid YAML fixture', async () => {
    const path = join(dir, 'min.yaml');
    await writeFile(
      path,
      [
        'issues:',
        '  - id: abc',
        '    identifier: SYMP-1',
        '    title: First task',
        '    state: Todo',
      ].join('\n'),
    );
    const result = await loadFixture(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toHaveLength(1);
      const [issue] = result.issues;
      expect(issue?.id).toBe('abc');
      expect(issue?.identifier).toBe('SYMP-1');
      expect(issue?.title).toBe('First task');
      expect(issue?.state).toBe('Todo');
      expect(issue?.labels).toEqual([]);
      expect(issue?.createdAt).toBeNull();
    }
  });

  it('lowercases labels (matches SPEC §11.3 normalization)', async () => {
    const path = join(dir, 'labels.yaml');
    await writeFile(
      path,
      [
        'issues:',
        '  - id: abc',
        '    identifier: SYMP-1',
        '    title: t',
        '    state: Todo',
        '    labels: [BUG, Frontend]',
      ].join('\n'),
    );
    const result = await loadFixture(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues[0]?.labels).toEqual(['bug', 'frontend']);
    }
  });

  it('parses ISO-8601 timestamps into Date objects', async () => {
    const path = join(dir, 'dates.yaml');
    await writeFile(
      path,
      [
        'issues:',
        '  - id: abc',
        '    identifier: SYMP-1',
        '    title: t',
        '    state: Todo',
        '    created_at: "2026-04-15T10:00:00Z"',
        '    updated_at: "2026-04-16T12:30:00Z"',
      ].join('\n'),
    );
    const result = await loadFixture(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues[0]?.createdAt).toEqual(new Date('2026-04-15T10:00:00Z'));
      expect(result.issues[0]?.updatedAt).toEqual(new Date('2026-04-16T12:30:00Z'));
    }
  });

  it('parses blocked_by entries with their state', async () => {
    const path = join(dir, 'blockers.yaml');
    await writeFile(
      path,
      [
        'issues:',
        '  - id: abc',
        '    identifier: SYMP-1',
        '    title: t',
        '    state: Todo',
        '    blocked_by:',
        '      - id: blocker-id',
        '        identifier: SYMP-99',
        '        state: In Progress',
      ].join('\n'),
    );
    const result = await loadFixture(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues[0]?.blockedBy).toEqual([
        { id: 'blocker-id', identifier: 'SYMP-99', state: 'In Progress' },
      ]);
    }
  });

  it('returns a validation error when an issue is missing a required field', async () => {
    const path = join(dir, 'invalid.yaml');
    await writeFile(path, ['issues:', '  - id: abc', '    title: t', '    state: Todo'].join('\n'));
    const result = await loadFixture(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('fixture_validation_error');
      expect(result.message).toContain('identifier');
    }
  });

  it('returns a parse error on malformed YAML', async () => {
    const path = join(dir, 'malformed.yaml');
    await writeFile(path, 'this is: not: valid: yaml');
    const result = await loadFixture(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('fixture_parse_error');
  });
});
