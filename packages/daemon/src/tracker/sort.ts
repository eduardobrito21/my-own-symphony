// Dispatch-order sort per SPEC §8.2.
//
// Stable intent (in priority order):
//   1. priority asc — 1..4 are preferred; null sorts LAST
//   2. createdAt oldest first — null sorts last
//   3. identifier lex ascending — final tiebreaker so the order is
//      deterministic given the same input set
//
// We sort a copy and never mutate the input; the orchestrator may
// reuse the original list elsewhere.

import type { Issue } from '../types/index.js';

/**
 * Return a new array with `issues` sorted in dispatch order. Pure
 * (no mutation, no I/O). SPEC §8.2.
 */
export function sortForDispatch(issues: readonly Issue[]): readonly Issue[] {
  return [...issues].sort(compareForDispatch);
}

function compareForDispatch(a: Issue, b: Issue): number {
  const byPriority = comparePriority(a.priority, b.priority);
  if (byPriority !== 0) return byPriority;

  const byCreatedAt = compareCreatedAt(a.createdAt, b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;

  // Identifier tiebreaker: localeCompare gives stable lex order
  // independent of host locale's default collation. We pass `'en'`
  // explicitly to avoid surprises in non-English-default environments.
  return a.identifier.localeCompare(b.identifier, 'en');
}

/**
 * `null` priority sorts after any numeric priority, regardless of
 * value. Within numerics, lower numbers come first (1 = highest).
 */
function comparePriority(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * `null` createdAt sorts after any non-null timestamp. Within
 * non-nulls, oldest first.
 */
function compareCreatedAt(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}
