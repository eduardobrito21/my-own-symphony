// Barrel for the workspace layer.

export { WorkspaceManager, type WorkspaceLogger, type CreateResult } from './manager.js';
export { runHook, type HookName, type HookRunResult } from './hooks.js';
export { workspacePathFor, assertContained } from './paths.js';
export type { WorkspaceError } from './errors.js';
