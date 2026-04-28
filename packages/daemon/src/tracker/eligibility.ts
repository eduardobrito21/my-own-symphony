// Structural eligibility per SPEC §8.2.
//
// "Structural" here means: the parts of eligibility that depend only
// on the issue and the configured state lists — NOT on orchestrator
// runtime state (concurrency limits, claimed/running sets). The
// orchestrator (Plan 04) layers the runtime checks on top of this.
//
// Splitting it this way means trackers can pre-filter their fetches
// (e.g. the Linear adapter's GraphQL query already filters to active
// states), and tests for "is this issue dispatchable in principle?"
// don't need to construct an orchestrator state.

import type { Issue } from '../types/index.js';

import { hasNonTerminalBlocker, isTodoState } from './blockers.js';
import { isStateAmong } from './state-matching.js';

export interface EligibilityConfig {
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
}

/**
 * Evaluation result. We return a typed reason rather than a boolean so
 * logs can explain *why* something was skipped.
 */
export type EligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: IneligibilityReason };

export type IneligibilityReason =
  | 'missing_required_field'
  | 'state_not_active'
  | 'state_terminal'
  | 'todo_with_non_terminal_blocker';

/**
 * Evaluate whether `issue` passes the structural checks in SPEC §8.2.
 *
 * The runtime checks (already running, already claimed, no available
 * concurrency slots) are applied separately by the orchestrator.
 */
export function evaluateEligibility(issue: Issue, config: EligibilityConfig): EligibilityResult {
  // Required fields per SPEC §8.2 first bullet. The schema layer
  // makes these non-null in the type, but real Linear payloads can
  // produce malformed records that get past validation; we
  // double-check here.
  if (issue.id === '' || issue.identifier === '' || issue.title === '' || issue.state === '') {
    return { eligible: false, reason: 'missing_required_field' };
  }

  if (isStateAmong(issue.state, config.terminalStates)) {
    return { eligible: false, reason: 'state_terminal' };
  }

  if (!isStateAmong(issue.state, config.activeStates)) {
    return { eligible: false, reason: 'state_not_active' };
  }

  if (isTodoState(issue.state) && hasNonTerminalBlocker(issue, config.terminalStates)) {
    return { eligible: false, reason: 'todo_with_non_terminal_blocker' };
  }

  return { eligible: true };
}
