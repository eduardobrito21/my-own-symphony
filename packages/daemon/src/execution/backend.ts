// `ExecutionBackend` — the abstraction Plan 09 introduces and
// ADR 0011 records.
//
// The orchestrator dispatches per-issue work by handing a backend
// the inputs it needs to start a pod with the agent already
// running inside it. The backend is responsible for:
//
//   1. Resolving + verifying the agent image (per ADR 0009's
//      image resolution order).
//   2. Starting the pod, mounting the workspace + task spec +
//      event socket, returning a handle whose `events` field is
//      the pod's stream of `AgentEvent`s.
//   3. Stopping the pod when the orchestrator says so (terminal
//      event, abort signal, daemon shutdown).
//
// What the backend is NOT responsible for:
//   - Building the workspace dir on the host. That's the
//     `WorkspaceManager` layer.
//   - Constructing the prompt or rendering the per-repo workflow.
//     The orchestrator does that and passes the result in the
//     `task` field.
//   - Token / budget accounting. The agent-runtime emits `usage`
//     events; the orchestrator accumulates them.
//
// V1 ships exactly one impl: `LocalDockerBackend` (Plan 09 stage
// 09c). A `FakeBackend` ships alongside for tests, in the same
// pattern as ADR 0007's `FakeTracker`.
//
// Future backends (`E2BBackend`, `EcsBackend`, `KubernetesJobBackend`)
// implement this same interface; the orchestrator never knows which
// is in use.

import type { AgentEvent } from '../agent/runner.js';
import type { IssueId, IssueIdentifier } from '../types/index.js';

import type { ExecutionResult } from './errors.js';

// ---------------------------------------------------------------------
// Image resolution — what the backend hands back from `ensureImage`.

/**
 * Where the resolved image came from. Surfaced for diagnostics +
 * dashboard so an operator can tell at a glance whether a project
 * is using its own image or falling back to the base.
 *
 * Mirrors Plan 09's image resolution order:
 *   1. `explicit`           — project config set `agent_image:`
 *   2. `repo-dockerfile`    — built from `<repo>/.symphony/agent.dockerfile`
 *   3. `devcontainer`       — built from `<repo>/.devcontainer/Dockerfile`
 *   4. `base`               — fell through to `execution.base_image`
 */
export type ImageSource = 'explicit' | 'repo-dockerfile' | 'devcontainer' | 'base';

export interface ImageSpec {
  /** Project key (Linear project_slug, sanitized) — used to scope
   *  per-repo image tag names. */
  readonly projectKey: string;
  /** Where the resolution should look first. The backend may walk
   *  the resolution order and end up using a different source. */
  readonly preferred: ImageSource;
  /** Explicit tag override from the project config, if any. */
  readonly explicitTag?: string;
  /** Workspace path on the host — for inspecting `.symphony/` and
   *  `.devcontainer/` after clone. */
  readonly workspacePath: string;
  /** Fallback base image tag (from `execution.base_image`). */
  readonly baseImage: string;
}

export interface ImageRef {
  /** Confirmed-present tag the backend will run. */
  readonly tag: string;
  /** Where the tag came from. */
  readonly source: ImageSource;
  /** Optional digest for diagnostics; backends that don't surface
   *  digests (e.g. local docker without registry) leave undefined. */
  readonly digest?: string;
}

// ---------------------------------------------------------------------
// Pod start — inputs and handle.

/**
 * The agent-runtime entrypoint reads its configuration from
 * `/etc/symphony/dispatch.json` (mounted read-only by the backend
 * at pod start). This shape is the contract; bumping it is a
 * breaking change for the agent-runtime image (base image major
 * version bump).
 *
 * Intentionally narrow: the envelope carries the daemon's
 * **dispatch decisions** (which issue, which repo, what caps).
 * It does NOT carry the issue body, the rendered prompt, or the
 * per-repo `allowedTools` list — those are the pod's job to
 * derive after fetching from Linear and reading `workflow.md`
 * from the cloned repo.
 *
 * The pod's startup flow is:
 *   1. Read this envelope.
 *   2. Fetch issue from `tracker` (using LINEAR_API_KEY env).
 *      If the issue is no longer eligible, exit cleanly.
 *   3. Clone `repo.url`, checkout/create `<branchPrefix><issueIdentifier>`.
 *   4. Read `<workspace>/<repo.workflowPath>` for the per-repo
 *      workflow definition.
 *   5. Render the prompt template against the freshly-fetched
 *      issue + `attempt`. Apply repo-side `model` / `allowedTools`,
 *      take `min(operatorCaps, repo_caps)` for budgets.
 *   6. Run the SDK; stream events to the daemon.
 *
 * See ADR 0011 for the full rationale on why the pod does this
 * itself rather than receiving a serialized snapshot from the
 * daemon.
 */
export interface DispatchEnvelope {
  readonly issueId: IssueId;
  readonly issueIdentifier: IssueIdentifier;
  readonly projectKey: string;

  /** Which tracker (and which project within it) the pod fetches
   *  the issue from. Discriminated for future tracker types. */
  readonly tracker: { readonly kind: 'linear'; readonly projectSlug: string };

  /** What the pod clones and operates on. */
  readonly repo: {
    readonly url: string;
    readonly defaultBranch: string;
    /** Path within the cloned repo to the per-repo workflow
     *  definition. Default: `.symphony/workflow.md`. */
    readonly workflowPath: string;
    /** Prefix for the per-issue branch name. The full branch is
     *  `<branchPrefix><issueIdentifier>`. Default: `symphony/`. */
    readonly branchPrefix: string;
  };

  /** Operator-side execution caps. The pod takes `min(this, repo_cap)`
   *  for budget fields; repo-side `workflow.md` wins for `model`
   *  and `allowedTools` (those are repo-team decisions, not
   *  operator-side). The fields here act as defaults / hard
   *  ceilings depending on the field. */
  readonly operatorCaps: {
    /** Default model when `workflow.md` doesn't pin one. */
    readonly model?: string;
    /** Hard ceiling on SDK round trips. */
    readonly maxTurns?: number;
    /** Hard ceiling on SDK cost (USD). */
    readonly maxBudgetUsd?: number;
  };

  /** Dispatch attempt number (null on first run, >=1 on retries).
   *  The agent-runtime can branch on this for retry-aware
   *  prompting. */
  readonly attempt: number | null;

  /** Optional resumed-session id (the agent-runtime tries
   *  `resume:` first when present). */
  readonly resumeSessionId?: string;
}

export interface PodStartInput {
  /** Project key — used (with `issueId`) to derive the pod's
   *  idempotent name. */
  readonly projectKey: string;
  readonly issueId: IssueId;
  readonly issueIdentifier: IssueIdentifier;
  /** Absolute host path to the per-issue workspace. The backend
   *  bind-mounts this into the pod at `/workspace`. */
  readonly workspacePath: string;
  /** Resolved image to run. Caller obtained it from `ensureImage`. */
  readonly image: ImageRef;
  /** Dispatch decisions the agent-runtime entrypoint reads at
   *  startup. Serialized to JSON and mounted at
   *  `/etc/symphony/dispatch.json`. */
  readonly envelope: DispatchEnvelope;
  /** Environment variables to set in the pod. The backend appends
   *  the standard `SYMPHONY_*` set on top of these (caller doesn't
   *  need to populate those). Secrets that the pod needs go here:
   *  `LINEAR_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`. */
  readonly env: Readonly<Record<string, string>>;
  /** Optional cancellation. When aborted, the backend stops the
   *  pod ASAP and the `events` iterable terminates. */
  readonly signal?: AbortSignal;
}

export interface PodHandle {
  /** Backend-specific identifier. For LocalDockerBackend this is
   *  the docker container id (or name). */
  readonly podId: string;
  /** Stream of agent events from the pod. Iteration ends when:
   *    - the agent emits a terminal event (turn_completed /
   *      turn_failed), OR
   *    - the pod exits, OR
   *    - the abort signal fires.
   *  Consumers do not need to call `stop()` after natural
   *  termination — the backend handles its own cleanup. They DO
   *  need to call `stop()` when bailing out early (abort, error). */
  readonly events: AsyncIterable<AgentEvent>;
  /** Diagnostics — last N bytes of the pod's stdout/stderr.
   *  Used in failure reports. Cheap to call; backends cache or
   *  read-on-demand. */
  readonly logsTail: () => Promise<string>;
}

// ---------------------------------------------------------------------
// The interface itself.

export interface ExecutionBackend {
  /**
   * Resolve and verify the image for a project. Implements the
   * per-ADR-0009 resolution order. Idempotent and fast — the
   * orchestrator may call it multiple times per dispatch.
   *
   * Returns:
   *   - ok: { tag, source, digest? }
   *   - error: image_not_found / image_build_failed
   *
   * Backends do NOT auto-build in v1; if the resolved tag isn't
   * present locally, return `image_not_found` with an actionable
   * message ("run `pnpm docker:build:<projectKey>` then retry").
   */
  ensureImage(spec: ImageSpec): Promise<ExecutionResult<ImageRef>>;

  /**
   * Start a pod with the agent-runtime entrypoint already running
   * inside it. MUST be idempotent on `(projectKey, issueId)`: if
   * a pod with that key already exists and is running, attach to
   * it (return a handle whose `events` resumes from wherever the
   * stream is at) rather than spawning a duplicate.
   *
   * The idempotency contract is what makes daemon-restart-mid-run
   * safe — the daemon comes back up, calls `start()` for the
   * still-pending issue, and reattaches to its already-running
   * pod.
   *
   * Returns:
   *   - ok: PodHandle
   *   - error: pod_start_failed (transient; orchestrator retries
   *            next tick)
   */
  start(input: PodStartInput): Promise<ExecutionResult<PodHandle>>;

  /**
   * Stop and clean up the pod. Idempotent: safe to call on a pod
   * that's already gone (returns ok). Stops are best-effort; the
   * orchestrator logs failures but does not retry on its own.
   *
   * Returns:
   *   - ok: void
   *   - error: pod_stop_failed (real docker / backend error;
   *            log-and-continue at call sites)
   *   - error: pod_not_found is NOT returned — already-gone is ok.
   */
  stop(handle: PodHandle): Promise<ExecutionResult<void>>;
}

// ---------------------------------------------------------------------
// Helpers.

/**
 * Sanitized pod name derived from project + issue. Used by every
 * backend to make `start()` idempotent — the same inputs produce
 * the same name, which the backend uses as the underlying pod
 * identifier (or as a label, for backends that don't support
 * named pods).
 *
 * Format: `symphony-<projectKey>-<issueId>`.
 *
 * The caller is expected to have already sanitized `projectKey`
 * and `issueId` to a docker-name-safe character set
 * (`[a-zA-Z0-9_.-]`). The existing `sanitizeIdentifier` from
 * `types/sanitize.ts` is the canonical sanitizer; backends should
 * not re-sanitize here — that would mask upstream bugs where an
 * unsafe id leaked through.
 */
export function podNameFor(projectKey: string, issueId: IssueId): string {
  return `symphony-${projectKey}-${issueId}`;
}
