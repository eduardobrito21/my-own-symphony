// Identifier sanitization per SPEC §4.2 / §15.2.
//
// Every workspace directory name must use only `[A-Za-z0-9._-]`. Any
// other character (whitespace, slashes, unicode, control characters)
// is replaced with `_` to keep the path safe. This is invariant 3 from
// SPEC §15.2 and is enforced before workspace creation.

import { WorkspaceKey, type IssueIdentifier } from './ids.js';

const UNSAFE_CHAR = /[^A-Za-z0-9._-]/g;

/**
 * Convert a tracker `IssueIdentifier` (e.g. "ABC-123 / fancy") into a
 * filesystem-safe `WorkspaceKey`. Every character outside
 * `[A-Za-z0-9._-]` is replaced with `_`.
 *
 * The transformation is deterministic and idempotent: passing an
 * already-safe identifier returns it unchanged.
 */
export function sanitizeIdentifier(identifier: IssueIdentifier): WorkspaceKey {
  const sanitized = identifier.replace(UNSAFE_CHAR, '_');
  // After sanitization the string is guaranteed to satisfy the
  // `WorkspaceKey` invariant, so the constructor will not throw —
  // unless the input was empty, which `IssueIdentifier`'s constructor
  // already rejects upstream.
  return WorkspaceKey(sanitized);
}
