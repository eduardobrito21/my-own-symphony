// Workspace path resolution and the SPEC §15.2 containment invariant.
//
// Two concerns kept deliberately separate:
//
//   1. `workspacePathFor` — pure compute. Sanitize the identifier,
//      join with the root. No filesystem access.
//
//   2. `assertContained` — defense-in-depth. Even though
//      `sanitizeIdentifier` already removes `/` and `..`, we re-check
//      that the resolved path stays inside the root. Two layers of
//      defense are cheap and catch implementation bugs (e.g. someone
//      bypassing sanitization, a future symbolic-link attack, etc.).
//
// SPEC §15.2 Invariant 2: "Workspace path MUST stay inside workspace
// root." This file is where that's enforced.

import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { sanitizeIdentifier, type IssueIdentifier, type ProjectKey } from '../types/index.js';

import type { WorkspaceContainmentError } from './errors.js';

/**
 * `Error` subclass that carries a typed `WorkspaceContainmentError`
 * payload. We use this (rather than throwing a plain object) for two
 * reasons:
 *
 *   - `instanceof Error` checks elsewhere keep working.
 *   - Stack traces are populated, which is what we want for an
 *     "unreachable" invariant violation.
 *
 * Catchers can `catch (e) { if (e instanceof WorkspaceContainmentException)
 * ... }` or pattern-match on `e.payload.code`.
 */
export class WorkspaceContainmentException extends Error {
  readonly payload: WorkspaceContainmentError;
  constructor(payload: WorkspaceContainmentError) {
    super(payload.message);
    this.name = 'WorkspaceContainmentException';
    this.payload = payload;
  }
}

/**
 * Compute the workspace path for an issue. Pure: no filesystem
 * access. The returned path is always absolute and is guaranteed to
 * be a child of `root`.
 *
 * Multi-project (ADR 0009 / Plan 09c): the path is namespaced by
 * `projectKey` so two projects that share an identifier prefix
 * (e.g. `EDU-1` in two different Linear workspaces) can't collide:
 *   `<root>/<projectKey>/<sanitized-identifier>/`
 *
 * In single-project compat mode (legacy WORKFLOW.md), the
 * orchestrator passes a synthetic `ProjectKey('default')` and the
 * resulting path is `<root>/default/<id>/`. To keep the legacy
 * laid-out layout (`<root>/<id>/`) on disk for compat-mode
 * deployments, the orchestrator can pass `null` for `projectKey`
 * and we'll skip the namespace segment entirely.
 *
 * @throws WorkspaceContainmentError as a thrown plain object if the
 * computed path would escape `root`. We *throw* here (rather than
 * returning a Result) because this should be unreachable — if it
 * fires, the sanitization logic itself is broken and we want the
 * stack trace.
 */
export function workspacePathFor(
  root: string,
  identifier: IssueIdentifier,
  projectKey: ProjectKey | null = null,
): string {
  const absoluteRoot = resolvePath(root);
  const key = sanitizeIdentifier(identifier);
  const candidate =
    projectKey === null
      ? resolvePath(absoluteRoot, key)
      : resolvePath(absoluteRoot, projectKey, key);
  assertContained(absoluteRoot, candidate);
  return candidate;
}

/**
 * Assert that `candidate` is contained within `root`. Used by
 * `workspacePathFor` and also exposed for direct use in tests and
 * pre-launch agent-runner checks (Plan 07).
 *
 * Containment means: `path.relative(root, candidate)` does not start
 * with `..` and is not absolute. The Node `path.relative` function
 * returns an OS-appropriate result we can inspect.
 */
export function assertContained(root: string, candidate: string): void {
  const absoluteRoot = resolvePath(root);
  const absoluteCandidate = resolvePath(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  // `..` prefix means the candidate is outside the root; an absolute
  // result happens when the two paths are on different filesystems
  // (e.g. different drives on Windows) — also a containment failure.
  if (rel.startsWith('..') || isAbsolute(rel)) {
    const payload: WorkspaceContainmentError = {
      code: 'workspace_containment',
      message: `Workspace path '${absoluteCandidate}' escapes root '${absoluteRoot}'.`,
      root: absoluteRoot,
      candidate: absoluteCandidate,
    };
    throw new WorkspaceContainmentException(payload);
  }
}
