// Fixture loading for the FakeTracker.
//
// Reads a YAML or JSON file from disk, validates it via the schema,
// and converts plain-string IDs into branded `Issue` values. JSON is
// supported only because YAML is a superset of JSON (the `yaml` lib
// parses both via the same call) — we do not switch parsers based on
// file extension.

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import {
  IssueId,
  IssueIdentifier,
  ProjectKey,
  type Issue,
  type BlockerRef,
} from '../../types/index.js';

import { FixtureSchema, type RawIssue } from './fixture-schema.js';

export interface FixtureLoadOk {
  readonly ok: true;
  readonly issues: readonly Issue[];
}

export interface FixtureLoadError {
  readonly ok: false;
  readonly code: 'fixture_not_found' | 'fixture_parse_error' | 'fixture_validation_error';
  readonly message: string;
  readonly path: string;
}

export type FixtureLoadResult = FixtureLoadOk | FixtureLoadError;

/**
 * Load and validate a fixture file. Returns branded `Issue` values
 * ready to drop into a `FakeTracker`.
 */
export async function loadFixture(path: string): Promise<FixtureLoadResult> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (cause) {
    const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null;
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'fixture_not_found',
        message: `Fixture file does not exist at ${path}.`,
        path,
      };
    }
    return {
      ok: false,
      code: 'fixture_parse_error',
      message: `Could not read fixture: ${stringifyCause(cause)}`,
      path,
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(content, { strict: true });
  } catch (cause) {
    return {
      ok: false,
      code: 'fixture_parse_error',
      message: `YAML parse error: ${stringifyCause(cause)}`,
      path,
    };
  }

  const validation = FixtureSchema.safeParse(raw);
  if (!validation.success) {
    const issueLines = validation.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    return {
      ok: false,
      code: 'fixture_validation_error',
      message: `Fixture failed validation:\n${issueLines}`,
      path,
    };
  }

  return {
    ok: true,
    issues: validation.data.issues.map(toDomainIssue),
  };
}

function toDomainIssue(raw: RawIssue): Issue {
  return {
    id: IssueId(raw.id),
    identifier: IssueIdentifier(raw.identifier),
    // Trackers don't know the project — the orchestrator stamps
    // the real `projectKey` after fetching, using the project
    // context the issue arrived through. We default to a sentinel
    // `default` so test fixtures and direct FakeTracker use stay
    // ergonomic. See ADR 0009 / Plan 09c.
    projectKey: ProjectKey('default'),
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    state: raw.state,
    branchName: raw.branch_name,
    url: raw.url,
    // Match SPEC §11.3: labels lowercase.
    labels: raw.labels.map((label) => label.toLowerCase()),
    blockedBy: raw.blocked_by.map(toDomainBlocker),
    createdAt: raw.created_at === null ? null : new Date(raw.created_at),
    updatedAt: raw.updated_at === null ? null : new Date(raw.updated_at),
  };
}

function toDomainBlocker(raw: {
  id: string | null;
  identifier: string | null;
  state: string | null;
}): BlockerRef {
  return {
    id: raw.id === null ? null : IssueId(raw.id),
    identifier: raw.identifier === null ? null : IssueIdentifier(raw.identifier),
    state: raw.state,
  };
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
