// Unit tests for the per-workspace session store.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NULL_LOGGER, type Logger } from '../../observability/index.js';

import {
  loadSessionOrNull,
  saveSession,
  sessionPathFor,
  type SessionRecord,
} from './session-store.js';

const RECORD: SessionRecord = {
  sessionId: 'sess-1',
  createdAt: '2026-04-29T10:00:00.000Z',
  lastTurnAt: '2026-04-29T10:05:00.000Z',
  model: 'claude-sonnet-4-5',
};

function makeMemoryLogger(): { logger: Logger; warns: { msg: string; meta: unknown }[] } {
  const warns: { msg: string; meta: unknown }[] = [];
  const logger: Logger = {
    info: vi.fn(),
    warn: (msg, meta) => warns.push({ msg, meta }),
    error: vi.fn(),
    with: () => logger,
  };
  return { logger, warns };
}

describe('session-store', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'symphony-session-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns null when the file does not exist (no warn)', async () => {
    const { logger, warns } = makeMemoryLogger();
    const got = await loadSessionOrNull(workspace, logger);
    expect(got).toBeNull();
    // Missing-file is the common case; silent.
    expect(warns).toHaveLength(0);
  });

  it('round-trips a saved record', async () => {
    await saveSession(workspace, RECORD);
    const got = await loadSessionOrNull(workspace, NULL_LOGGER);
    expect(got).toEqual(RECORD);
  });

  it('writes the file under <workspace>/.symphony/session.json', async () => {
    await saveSession(workspace, RECORD);
    const path = sessionPathFor(workspace);
    expect(path).toBe(join(workspace, '.symphony', 'session.json'));
    const stats = await stat(path);
    expect(stats.isFile()).toBe(true);
  });

  it('returns null and warns on corrupt JSON', async () => {
    const { logger, warns } = makeMemoryLogger();
    const path = sessionPathFor(workspace);
    await saveSession(workspace, RECORD); // creates dir
    await writeFile(path, '{"sessionId": "sess-1", broken-json', 'utf8');
    const got = await loadSessionOrNull(workspace, logger);
    expect(got).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe('session_file_corrupt_json');
  });

  it('returns null and warns on schema mismatch', async () => {
    const { logger, warns } = makeMemoryLogger();
    const path = sessionPathFor(workspace);
    await saveSession(workspace, RECORD);
    // Old / hand-edited format that no longer matches the schema.
    await writeFile(path, JSON.stringify({ sessionId: 'sess-1' }), 'utf8');
    const got = await loadSessionOrNull(workspace, logger);
    expect(got).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe('session_file_schema_mismatch');
  });

  it('overwrites an existing record on save', async () => {
    await saveSession(workspace, RECORD);
    const updated: SessionRecord = { ...RECORD, sessionId: 'sess-2' };
    await saveSession(workspace, updated);
    const got = await loadSessionOrNull(workspace, NULL_LOGGER);
    expect(got?.sessionId).toBe('sess-2');
  });

  it('does not leave .tmp files behind on success', async () => {
    await saveSession(workspace, RECORD);
    const dirPath = join(workspace, '.symphony');
    // Read the directory and assert nothing matches *.tmp.
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(dirPath);
    const stragglers = entries.filter((name) => name.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });

  it('emits valid JSON that can be re-read by readFile', async () => {
    await saveSession(workspace, RECORD);
    const raw = await readFile(sessionPathFor(workspace), 'utf8');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });
});
