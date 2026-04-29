// Per-workspace session ID persistence for `ClaudeAgent`.
//
// Why a file inside the workspace:
//   - lifecycle matches the workspace itself (per-issue, cleaned up
//     when the issue goes terminal),
//   - survives daemon restarts because it's on disk,
//   - inspectable for debugging (just `cat .symphony/session.json`).
//
// Why a `loadOrNull` instead of "throw on missing": the session is an
// optimization, not a correctness invariant. If the file is missing
// (first turn) or corrupt (operator edited it, disk truncation, etc.)
// we want to silently fall back to a fresh session — the caller logs
// a WARN on corruption so an operator can investigate, but no run
// fails because of session-file trouble.
//
// Atomic write pattern: write to a sibling `.tmp` file under the same
// directory, then `rename` over the target. POSIX rename is atomic
// within a filesystem, so a crash mid-write either leaves the old
// file intact or replaces it cleanly — never a half-written JSON.
//
// SPEC §15.2 invariant: nothing under the workspace dir is read by
// the agent itself; only the daemon. The session file lives under
// `.symphony/` to make that boundary visually obvious.

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { Logger } from '../../observability/index.js';

/**
 * The shape persisted per workspace. We only NEED `sessionId` to
 * resume; the timestamps and `model` are debug breadcrumbs that an
 * operator (or a future "session aged out, drop it" rule) can use.
 */
export const SessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  /** ISO-8601. When the session was first created. */
  createdAt: z.string().datetime(),
  /** ISO-8601. When the most recent turn finished. */
  lastTurnAt: z.string().datetime(),
  /** Model id used at create time — e.g. `claude-sonnet-4-5`. */
  model: z.string().min(1),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const SESSION_DIR_NAME = '.symphony';
export const SESSION_FILE_NAME = 'session.json';

/** Compute the on-disk path for a workspace's session file. */
export function sessionPathFor(workspacePath: string): string {
  return join(workspacePath, SESSION_DIR_NAME, SESSION_FILE_NAME);
}

/**
 * Load and parse the session for a workspace.
 *
 * Returns `null` in three cases — all of them recoverable, none of
 * them an error from the caller's perspective:
 *   1. The file does not exist (first turn for this workspace).
 *   2. The file exists but isn't valid JSON.
 *   3. The file exists, parses as JSON, but doesn't match the schema
 *      (e.g. an old format, hand-edited).
 *
 * Cases 2 and 3 emit a WARN log so an operator can notice. The
 * caller's response is the same: start a fresh session.
 */
export async function loadSessionOrNull(
  workspacePath: string,
  logger: Logger,
): Promise<SessionRecord | null> {
  const path = sessionPathFor(workspacePath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) {
      // Missing file is the common case (first turn). Silent.
      return null;
    }
    logger.warn('session_file_unreadable', {
      path,
      error: stringifyCause(cause),
    });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    logger.warn('session_file_corrupt_json', {
      path,
      error: stringifyCause(cause),
    });
    return null;
  }

  const result = SessionRecordSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn('session_file_schema_mismatch', {
      path,
      error: result.error.message,
    });
    return null;
  }
  return result.data;
}

/**
 * Persist a session record to disk atomically.
 *
 * The directory is created if missing (first save for a workspace).
 * Writes go to a sibling `.tmp` file then rename over the target;
 * POSIX rename is atomic within a filesystem, so a crash never
 * leaves a half-written JSON behind.
 */
export async function saveSession(
  workspacePath: string,
  record: SessionRecord,
  // Allow tests to provide a deterministic temp suffix; default uses
  // a monotonic-ish counter so multiple writes within a tick don't
  // collide on the same temp filename.
  tempSuffix = `${String(process.pid)}-${String(saveSession.tick++)}`,
): Promise<void> {
  const finalPath = sessionPathFor(workspacePath);
  const dir = dirname(finalPath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${finalPath}.${tempSuffix}.tmp`;
  const body = JSON.stringify(record, null, 2);
  try {
    await writeFile(tmpPath, body, { encoding: 'utf8' });
    await rename(tmpPath, finalPath);
  } catch (cause) {
    // Best-effort cleanup of the temp file on failure. Suppress any
    // errors here — they'd shadow the real cause.
    try {
      await unlink(tmpPath);
    } catch {
      /* intentionally empty */
    }
    throw cause;
  }
}
saveSession.tick = 0;

// ---------------------------------------------------------------------
// Internals.

function isNodeErrnoCode(cause: unknown, code: string): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const maybe = cause as { code?: unknown };
  return typeof maybe.code === 'string' && maybe.code === code;
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
