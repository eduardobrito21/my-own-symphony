// Runtime eligibility — composes Plan 02's structural eligibility
// (`tracker/eligibility.ts`) with orchestrator-state checks
// (`already running`, `already claimed`, concurrency slots).
//
// Plan 02 answered "is this issue dispatchable in principle?"
// Plan 04 answers "is this issue dispatchable RIGHT NOW given what
// the orchestrator is currently doing?"
//
// Per SPEC §8.2 the runtime checks are:
//   - not already in `running`
//   - not already in `claimed`
//   - global concurrency slots available
//   - per-state concurrency slots available

import type { AgentConfig, TrackerConfig } from '../config/schema.js';
import type { Issue } from '../types/index.js';
import {
  evaluateEligibility,
  type EligibilityResult,
  type IneligibilityReason,
} from '../tracker/eligibility.js';
import { normalizeState } from '../tracker/state-matching.js';

import type { MutableOrchestratorState } from './state.js';

/**
 * Reasons the orchestrator might skip an issue at dispatch time.
 * Extends the structural reasons with runtime-state ones.
 */
export type RuntimeIneligibilityReason =
  | IneligibilityReason
  | 'already_running'
  | 'already_claimed'
  | 'no_global_slot'
  | 'no_per_state_slot';

export type RuntimeEligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: RuntimeIneligibilityReason };

export interface RuntimeEligibilityArgs {
  readonly state: MutableOrchestratorState;
  readonly tracker: TrackerConfig;
  readonly agent: AgentConfig;
}

/**
 * Decide whether `issue` is dispatchable right now.
 *
 * Order of checks matters for log clarity: structural reasons
 * (state, blockers, missing fields) come first because they're
 * properties of the issue itself; runtime reasons come second
 * because they depend on the orchestrator's current state and
 * can change tick-to-tick.
 */
export function evaluateRuntimeEligibility(
  issue: Issue,
  args: RuntimeEligibilityArgs,
): RuntimeEligibilityResult {
  const structural = evaluateEligibility(issue, {
    activeStates: args.tracker.active_states,
    terminalStates: args.tracker.terminal_states,
  });
  if (!structural.eligible) {
    return liftStructural(structural);
  }

  const { state, agent } = args;
  if (state.running.has(issue.id)) {
    return { eligible: false, reason: 'already_running' };
  }
  if (state.claimed.has(issue.id)) {
    return { eligible: false, reason: 'already_claimed' };
  }

  const runningCount = state.running.size;
  if (runningCount >= agent.max_concurrent_agents) {
    return { eligible: false, reason: 'no_global_slot' };
  }

  const perStateCap = agent.max_concurrent_agents_by_state[normalizeState(issue.state)];
  if (perStateCap !== undefined) {
    let runningInState = 0;
    for (const entry of state.running.values()) {
      if (normalizeState(entry.issue.state) === normalizeState(issue.state)) {
        runningInState += 1;
      }
    }
    if (runningInState >= perStateCap) {
      return { eligible: false, reason: 'no_per_state_slot' };
    }
  }

  return { eligible: true };
}

function liftStructural(result: EligibilityResult): RuntimeEligibilityResult {
  if (result.eligible) return { eligible: true };
  return { eligible: false, reason: result.reason };
}
