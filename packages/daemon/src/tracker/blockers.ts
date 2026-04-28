// Blocker-rule helpers.
//
// SPEC §8.2: "If the issue state is `Todo`, do not dispatch when any
// blocker is non-terminal." Issues in any other state are not gated by
// blockers.
//
// "Non-terminal" means: not in the configured `terminal_states` list,
// or unknown state (the blocker reference is incomplete).

import type { Issue } from '../types/index.js';

import { isStateAmong, normalizeState } from './state-matching.js';

/**
 * Return `true` if any blocker on `issue` has a state that is NOT in
 * `terminalStates`. A blocker with `state === null` (unknown/deleted)
 * counts as non-terminal — we treat unknown blockers conservatively.
 *
 * Callers use this only when the issue's state is `Todo`; for any
 * other state the blocker rule does not apply.
 */
export function hasNonTerminalBlocker(issue: Issue, terminalStates: readonly string[]): boolean {
  return issue.blockedBy.some((blocker) => {
    if (blocker.state === null) return true;
    return !isStateAmong(blocker.state, terminalStates);
  });
}

/**
 * Return `true` if the issue's state is exactly `todo` (case-insensitive).
 *
 * The blocker rule per SPEC §8.2 is gated on this specific state name.
 */
export function isTodoState(state: string): boolean {
  return normalizeState(state) === 'todo';
}
