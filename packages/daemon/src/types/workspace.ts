// `Workspace` per SPEC §4.1.4. The filesystem assignment for one issue.
//
// `path` is the absolute directory; `key` is the sanitized identifier
// used as the directory's name. `createdNow` is the gate the workspace
// manager (Plan 03) uses to decide whether to run the `after_create`
// hook on this run.

import type { WorkspaceKey } from './ids.js';

export interface Workspace {
  /** Absolute filesystem path, contained within `workspace.root`. */
  readonly path: string;
  readonly key: WorkspaceKey;
  /**
   * `true` only on the run that just created the directory. Reused
   * workspaces report `false`. SPEC §4.1.4 / §9.4.
   */
  readonly createdNow: boolean;
}
