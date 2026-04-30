// Per-project context wired up to the orchestrator (Plan 09c).
//
// The orchestrator was single-project through Plan 08 (one
// `Tracker`, one set of `active_states`, one workspace root).
// ADR 0009 introduces multi-project: the daemon can watch N
// projects, each with its own Linear project_slug, repo
// coordinates, and (in some configurations) state-name conventions.
//
// `ProjectContext` is the per-project bundle the orchestrator
// iterates over. It carries everything project-specific the
// orchestrator needs at tick time:
//
//   - `key` — the sanitized project identifier; stamped onto every
//     `Issue` the orchestrator accumulates from this project's
//     tracker (so downstream consumers can partition state).
//   - `tracker` — the per-project tracker instance. Multiple
//     trackers typically share one underlying `LinearClient`
//     (auth + transport in one place) but each is constructed
//     with a different `project_slug`.
//   - `activeStates` / `terminalStates` — operator-side state-name
//     conventions for this project. Different teams may name
//     their "in progress" state differently (e.g. "Doing",
//     "WIP"); per-project lists let each project use its own
//     vocabulary.
//
// `ProjectContextMap` is `ReadonlyMap<ProjectKey, ProjectContext>`
// with insertion-ordered iteration (deliberate: snapshot
// project order matches the deployment YAML order, which the
// dashboard renders as-is).

import type { Tracker } from '../tracker/tracker.js';
import { type ProjectKey } from '../types/index.js';

export interface ProjectContext {
  /** Sanitized project key. Same value the orchestrator stamps on
   *  every `Issue` accumulated from this project's tracker. */
  readonly key: ProjectKey;
  /** Per-project tracker. May share a `LinearClient` with sibling
   *  projects; the construction-time slug is what differentiates
   *  one tracker from another. */
  readonly tracker: Tracker;
  /** State names this project considers "actively in flight"
   *  (eligible for dispatch, kept claimed by reconcile). */
  readonly activeStates: readonly string[];
  /** State names this project treats as terminal (reconcile
   *  terminates the worker; startup sweep removes the workspace). */
  readonly terminalStates: readonly string[];
}

/** Insertion-ordered map of project contexts. Order is the
 *  deployment YAML order. */
export type ProjectContextMap = ReadonlyMap<ProjectKey, ProjectContext>;

/**
 * Build a single-entry `ProjectContextMap` for callers (mostly
 * tests + the legacy WORKFLOW.md compat path) that have one
 * tracker and don't otherwise need multi-project plumbing.
 *
 * The synthesized key is `ProjectKey('default')` — matches the
 * fallback `Issue.projectKey` value used by test fixtures and the
 * legacy compat path.
 */
export function singleProjectContext(args: {
  readonly key: ProjectKey;
  readonly tracker: Tracker;
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
}): ProjectContextMap {
  const ctx: ProjectContext = {
    key: args.key,
    tracker: args.tracker,
    activeStates: args.activeStates,
    terminalStates: args.terminalStates,
  };
  return new Map([[args.key, ctx]]);
}
