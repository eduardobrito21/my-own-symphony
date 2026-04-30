// Branded ID types.
//
// Why this pattern: SPEC §4.2 distinguishes several string-shaped values
// that look the same but are semantically different and *must not* be
// mixed up:
//
//   - IssueId         — opaque tracker-internal ID (e.g. Linear's UUID)
//   - IssueIdentifier — human ticket key (e.g. "ABC-123")
//   - WorkspaceKey    — sanitized identifier used as a directory name
//   - SessionId       — composite "<thread_id>-<turn_id>" string
//
// All four are `string` at runtime. Without branding, TypeScript would
// happily let us pass `issue.identifier` where `issue.id` was expected,
// and the bug would only surface at runtime when, say, the tracker
// returned no results. Branded types catch this at compile time.
//
// How it works:
//   - We declare a unique symbol per brand.
//   - The TYPE is `string & { [Brand]: true }` — at runtime this is
//     just a string; at compile time it carries an extra phantom
//     property that distinguishes it from other branded strings and
//     from plain `string`.
//   - We define a constructor function with the SAME NAME as the type.
//     TypeScript allows this because types and values live in different
//     namespaces. So `IssueId('abc')` returns a value typed as
//     `IssueId`, and `IssueId` (in a type position) is the type.
//
// Trade-off: any code that constructs an ID has to use the constructor
// (`IssueId(value)`) instead of just passing a string. That's the
// price for the type safety.

declare const IssueIdBrand: unique symbol;
declare const IssueIdentifierBrand: unique symbol;
declare const WorkspaceKeyBrand: unique symbol;
declare const SessionIdBrand: unique symbol;
declare const ProjectKeyBrand: unique symbol;

export type IssueId = string & { readonly [IssueIdBrand]: true };
export type IssueIdentifier = string & { readonly [IssueIdentifierBrand]: true };
export type WorkspaceKey = string & { readonly [WorkspaceKeyBrand]: true };
export type SessionId = string & { readonly [SessionIdBrand]: true };
/**
 * Multi-project identifier (ADR 0009). Sanitized form of the operator's
 * project label (typically the Linear project_slug). Must match the
 * same character set as `WorkspaceKey` because it appears in
 * filesystem paths (`<workspace.root>/<project_key>/<issue_id>/`)
 * and docker container names (`symphony-<project>-<issue>`).
 */
export type ProjectKey = string & { readonly [ProjectKeyBrand]: true };

/**
 * Construct an `IssueId`. Validates that the input is a non-empty string.
 *
 * @throws if `value` is empty.
 */
export function IssueId(value: string): IssueId {
  if (value === '') {
    throw new Error('IssueId must be a non-empty string.');
  }
  return value as IssueId;
}

/**
 * Construct an `IssueIdentifier` (e.g. "ABC-123"). Validates non-empty.
 *
 * @throws if `value` is empty.
 */
export function IssueIdentifier(value: string): IssueIdentifier {
  if (value === '') {
    throw new Error('IssueIdentifier must be a non-empty string.');
  }
  return value as IssueIdentifier;
}

/**
 * Construct a `WorkspaceKey`. Validates that the input contains only the
 * sanitized character set per SPEC §15.2 / §4.2. Use
 * `sanitizeIdentifier` to derive a key from an unsafe identifier.
 *
 * @throws if `value` contains characters outside `[A-Za-z0-9._-]` or is empty.
 */
export function WorkspaceKey(value: string): WorkspaceKey {
  if (value === '' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `WorkspaceKey must match /^[A-Za-z0-9._-]+$/ (got '${value}'). ` +
        `Use sanitizeIdentifier() to derive a key from a tracker identifier.`,
    );
  }
  return value as WorkspaceKey;
}

/**
 * Construct a `SessionId`. The canonical shape is `<threadId>-<turnId>`
 * (SPEC §4.2). We accept any non-empty string here since session IDs
 * arrive from the agent backend and we don't want to reject novel
 * formats; callers that compose IDs from `threadId` and `turnId` should
 * use `composeSessionId`.
 *
 * @throws if `value` is empty.
 */
export function SessionId(value: string): SessionId {
  if (value === '') {
    throw new Error('SessionId must be a non-empty string.');
  }
  return value as SessionId;
}

/**
 * Compose a session ID from a thread ID and a turn ID per SPEC §4.2.
 */
export function composeSessionId(threadId: string, turnId: string): SessionId {
  return SessionId(`${threadId}-${turnId}`);
}

/**
 * Construct a `ProjectKey`. Validates the same sanitized character
 * set as `WorkspaceKey` because the value appears in filesystem
 * paths and docker container names.
 *
 * @throws if `value` contains characters outside `[A-Za-z0-9._-]`
 *         or is empty.
 */
export function ProjectKey(value: string): ProjectKey {
  if (value === '' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `ProjectKey must match /^[A-Za-z0-9._-]+$/ (got '${value}'). ` +
        `Use sanitizeProjectSlug() to derive a key from a Linear project slug.`,
    );
  }
  return value as ProjectKey;
}
