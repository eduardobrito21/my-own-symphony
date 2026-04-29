// Convert validated Linear response shapes into our domain `Issue`.
//
// SPEC §11.3 normalization rules:
//   - labels lowercased
//   - blockers from inverse-relations of type `blocks`
//   - priority kept as integer or null
//   - timestamps parsed from ISO-8601 to Date
//
// We have two normalizers:
//   - `normalizeFullIssue`    — for dispatch + cleanup paths
//   - `normalizeMinimalIssue` — for reconciliation (id + identifier
//                               + state only; other fields filled with
//                               null/empty placeholders so the
//                               `Issue` type still parses)

import { IssueId, IssueIdentifier, type BlockerRef, type Issue } from '../../types/index.js';

import type { FullIssue, MinimalIssue } from './responses.js';

/**
 * Full normalization: every field of `Issue` is populated from
 * Linear's response.
 */
export function normalizeFullIssue(raw: FullIssue): Issue {
  return {
    id: IssueId(raw.id),
    identifier: IssueIdentifier(raw.identifier),
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    state: raw.state.name,
    branchName: raw.branchName,
    url: raw.url,
    labels: raw.labels.nodes.map((n) => n.name.toLowerCase()),
    blockedBy: raw.inverseRelations.nodes
      // Linear's schema doesn't accept a filter argument on
      // `inverseRelations`, so we narrow to "blocks" client-side.
      // Other types we ignore here include `duplicate`, `related`.
      .filter((n) => n.type === 'blocks')
      .map(toBlockerRef)
      // Drop nulls (relations whose blocker issue was deleted).
      .filter((b): b is BlockerRef => b !== null),
    createdAt: raw.createdAt === null ? null : new Date(raw.createdAt),
    updatedAt: raw.updatedAt === null ? null : new Date(raw.updatedAt),
  };
}

/**
 * Minimal normalization: only `id`, `identifier`, and `state` come
 * from Linear. Other fields are filled with null/empty placeholders.
 *
 * Used for reconciliation queries where we only need to know the
 * current state. The orchestrator's reconciliation code never inspects
 * `description` / `labels` / etc. on these snapshots — but the type
 * system requires them, so we provide the cheapest valid values.
 */
export function normalizeMinimalIssue(raw: MinimalIssue): Issue {
  return {
    id: IssueId(raw.id),
    identifier: IssueIdentifier(raw.identifier),
    title: '',
    description: null,
    priority: null,
    state: raw.state.name,
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Convert a Linear inverse-relation node (already narrowed to type
 * `blocks` by the caller) into our `BlockerRef`. Returns null if the
 * relation's referenced issue was deleted (Linear surfaces this as
 * `issue: null`).
 */
function toBlockerRef(node: {
  type: string;
  issue: { id: string; identifier: string; state: { name: string } | null } | null;
}): BlockerRef | null {
  if (node.issue === null) return null;
  return {
    id: IssueId(node.issue.id),
    identifier: IssueIdentifier(node.issue.identifier),
    state: node.issue.state === null ? null : node.issue.state.name,
  };
}
