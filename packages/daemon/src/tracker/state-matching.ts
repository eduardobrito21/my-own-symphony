// State-name comparison helpers.
//
// SPEC §4.2: "Compare states after `lowercase`." All matching of issue
// states against `active_states` / `terminal_states` flows through
// these helpers so the casing rule is applied in exactly one place.

/**
 * Lowercase a state name for comparison. Returns the input unchanged
 * if already lowercase.
 */
export function normalizeState(state: string): string {
  return state.toLowerCase();
}

/**
 * Return `true` if `state` matches any name in `candidates` after
 * case-insensitive comparison.
 */
export function isStateAmong(state: string, candidates: readonly string[]): boolean {
  const target = normalizeState(state);
  return candidates.some((c) => normalizeState(c) === target);
}
