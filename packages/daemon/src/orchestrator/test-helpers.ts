// Shared helpers for orchestrator + adjacent layer tests.
//
// Plan 09c made the orchestrator multi-project. Most existing tests
// (Plans 04, 05, 07, 08) were written against the single-project
// shape. Rather than churn every test individually, we expose:
//
//   - `defaultProjectKey()` — `ProjectKey('default')`, the sentinel
//     used by single-project compat mode and test fixtures.
//   - `defaultProjects(tracker, opts?)` — synthesize a one-entry
//     ProjectContextMap with the default key + the standard
//     active/terminal state lists. Drop-in replacement for the
//     legacy `tracker:` argument on `Orchestrator`.
//
// These are test-only utilities; production code uses
// `singleProjectContext` directly when running in compat mode.

import type { Tracker } from '../tracker/tracker.js';
import { ProjectKey } from '../types/index.js';

import { singleProjectContext, type ProjectContextMap } from './project.js';

/** The single sentinel project key used everywhere we don't have a
 *  real multi-project deployment in play (tests + legacy compat). */
export function defaultProjectKey(): ProjectKey {
  return ProjectKey('default');
}

/** Build a one-entry ProjectContextMap suitable for any test that
 *  used to pass `tracker:` to the Orchestrator. Active/terminal
 *  state names default to the canonical set. */
export function defaultProjects(
  tracker: Tracker,
  opts: {
    readonly activeStates?: readonly string[];
    readonly terminalStates?: readonly string[];
  } = {},
): ProjectContextMap {
  return singleProjectContext({
    key: defaultProjectKey(),
    tracker,
    activeStates: opts.activeStates ?? ['Todo', 'In Progress'],
    terminalStates: opts.terminalStates ?? ['Done', 'Cancelled'],
  });
}
