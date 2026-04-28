// Barrel re-exports for the domain type layer.
//
// Layers above (`config/`, `tracker/`, `workspace/`, `agent/`,
// `orchestrator/`, `http/`, `observability/`) import from
// `'./types/index.js'` rather than reaching into individual files. The
// barrel makes it easy to see the full domain surface at a glance.

export { IssueId, IssueIdentifier, WorkspaceKey, SessionId, composeSessionId } from './ids.js';

export type { Issue, BlockerRef } from './issue.js';
export type { Workspace } from './workspace.js';
export type { RunAttempt, RunAttemptStatus } from './run-attempt.js';
export type { LiveSession, AgentTokenCounters } from './session.js';
export type { RetryEntry } from './retry-entry.js';
export type { OrchestratorState, RunningEntry, AgentTotals } from './orchestrator-state.js';

export { sanitizeIdentifier } from './sanitize.js';
