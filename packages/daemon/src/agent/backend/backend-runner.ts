// `BackendAgentRunner` — adapts an `ExecutionBackend` to the
// `AgentRunner` interface the orchestrator already consumes.
//
// Per Plan 10, the production agent runs **inside** a Docker pod
// started by `LocalDockerBackend`, not in-process. ADR 0011's longer-
// term plan moves the orchestrator off `AgentRunner` entirely and onto
// `ExecutionBackend.start(...)` directly. This adapter is the
// shorter-term shim that lets us ship the pod runtime without
// rewriting every orchestrator test that constructs a `MockAgent`:
//
//   composition root:
//     agent = new BackendAgentRunner({
//       backend: new LocalDockerBackend(...),
//       projects,
//       ...
//     })
//   orchestrator: unchanged (still calls `agent.run(input)`)
//
// `run(input)` does the dispatch dance:
//   1. Look up the project context (for repo coordinates + tracker
//      project slug).
//   2. Resolve the image (`backend.ensureImage(spec)`).
//   3. Build the dispatch envelope.
//   4. Call `backend.start(podStartInput)` to get a `PodHandle`.
//   5. Yield events from `handle.events`.
//   6. Call `backend.stop(handle)` when iteration ends (terminal
//      event, abort, or stream close).
//
// Errors at every step yield a `turn_failed` event and return — the
// orchestrator already handles that as an abnormal exit and schedules
// a retry per its own policy.

import type { Logger } from '../../observability/index.js';
import type { ProjectKey, IssueId } from '../../types/index.js';
import {
  buildDispatchEnvelope,
  type ExecutionBackend,
  type PodStartInput,
} from '../../execution/index.js';
import type { AgentEvent, AgentRunInput, AgentRunner } from '../runner.js';

export interface BackendAgentRunnerArgs {
  readonly backend: ExecutionBackend;
  /** Per-project repo + tracker config derived from `symphony.yaml`.
   *  Indexed by project key. The adapter looks up envelope-shaping
   *  data here. */
  readonly projectDispatch: ReadonlyMap<ProjectKey, ProjectDispatchInfo>;
  /** Operator-side execution caps the pod takes `min(...)` against
   *  the per-repo workflow.md caps. */
  readonly operatorCaps: {
    readonly model?: string;
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
  };
  /** Default base image — only used when image resolution falls
   *  through. */
  readonly baseImage: string;
  /** Env vars (secrets) to plumb into the pod. The adapter forwards
   *  these verbatim to `backend.start(input)`. Typical contents:
   *  `LINEAR_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`. */
  readonly env: Readonly<Record<string, string>>;
  readonly logger: Logger;
  /** Test seam — defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Per-project repo + tracker info needed to build a dispatch envelope.
 * Shape lives in this module rather than in `project.ts` because
 * `ProjectContext` (orchestrator-facing) intentionally only carries
 * runtime tracker state. The repo coordinates here come from
 * `symphony.yaml`'s `projects[].repo`.
 */
export interface ProjectDispatchInfo {
  readonly trackerProjectSlug: string;
  readonly repo: {
    readonly url: string;
    readonly defaultBranch: string;
    readonly workflowPath: string;
    readonly branchPrefix: string;
    readonly explicitImageTag?: string;
  };
}

export class BackendAgentRunner implements AgentRunner {
  private readonly backend: ExecutionBackend;
  private readonly projectDispatch: ReadonlyMap<ProjectKey, ProjectDispatchInfo>;
  private readonly operatorCaps: BackendAgentRunnerArgs['operatorCaps'];
  private readonly baseImage: string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(args: BackendAgentRunnerArgs) {
    this.backend = args.backend;
    this.projectDispatch = args.projectDispatch;
    this.operatorCaps = args.operatorCaps;
    this.baseImage = args.baseImage;
    this.env = args.env;
    this.logger = args.logger;
    this.now = args.now ?? (() => new Date());
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const log = this.logger.with({
      issue_id: input.issueId,
      issue_identifier: input.issueIdentifier,
    });

    // The orchestrator passes us an already-rendered prompt, but the
    // pod re-renders from the per-repo `workflow.md` (per ADR 0011).
    // We discard the rendered prompt and pass dispatch metadata
    // through the envelope instead. The orchestrator's render is now
    // dead code on this path; it stays for `MockAgent` compatibility.
    const projectKey = await this.findProjectKeyByIssue(input.issueId);
    if (projectKey === null) {
      log.error('cannot resolve project for issue; pod cannot start');
      yield this.failed('issue does not belong to a known project');
      return;
    }
    const dispatch = this.projectDispatch.get(projectKey);
    if (dispatch === undefined) {
      yield this.failed(`no dispatch info for project ${projectKey}`);
      return;
    }

    // 1. Resolve image.
    const imageResult = await this.backend.ensureImage({
      projectKey,
      preferred: dispatch.repo.explicitImageTag !== undefined ? 'explicit' : 'base',
      ...(dispatch.repo.explicitImageTag !== undefined && {
        explicitTag: dispatch.repo.explicitImageTag,
      }),
      workspacePath: input.workspacePath,
      baseImage: this.baseImage,
    });
    if (!imageResult.ok) {
      log.error('image resolution failed', {
        code: imageResult.error.code,
        message: imageResult.error.message,
      });
      yield this.failed(
        `image resolution failed (${imageResult.error.code}): ${imageResult.error.message}`,
      );
      return;
    }

    // 2. Envelope.
    const envelope = buildDispatchEnvelope({
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      projectKey,
      trackerProjectSlug: dispatch.trackerProjectSlug,
      repoUrl: dispatch.repo.url,
      defaultBranch: dispatch.repo.defaultBranch,
      workflowPath: dispatch.repo.workflowPath,
      branchPrefix: dispatch.repo.branchPrefix,
      operatorCaps: this.operatorCaps,
      attempt: input.attempt,
    });

    // 3. Start pod.
    const podInput: PodStartInput = {
      projectKey,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      workspacePath: input.workspacePath,
      image: imageResult.value,
      envelope,
      env: this.env,
      ...(input.signal !== undefined && { signal: input.signal }),
    };
    const startResult = await this.backend.start(podInput);
    if (!startResult.ok) {
      log.error('pod start failed', {
        code: startResult.error.code,
        message: startResult.error.message,
      });
      yield this.failed(
        `pod start failed (${startResult.error.code}): ${startResult.error.message}`,
      );
      return;
    }
    const handle = startResult.value;
    log.info('pod started', { pod_id: handle.podId, image: imageResult.value.tag });

    // 4. Stream events. Always stop the pod when iteration ends.
    let sawTerminal = false;
    try {
      for await (const event of handle.events) {
        if (event.kind === 'turn_completed' || event.kind === 'turn_failed') {
          sawTerminal = true;
        }
        yield event;
      }
    } finally {
      // Defensive: if the pod's stream ended without a terminal event
      // (pod crashed, socket closed early), synthesize one so the
      // orchestrator's exit-classification path treats it as abnormal
      // rather than as a clean completion.
      if (!sawTerminal) {
        yield this.failed('pod event stream ended without a terminal event');
      }
      const stopResult = await this.backend.stop(handle);
      if (!stopResult.ok) {
        log.warn('pod stop failed (logged + continuing)', {
          code: stopResult.error.code,
          message: stopResult.error.message,
        });
      }
    }
  }

  /**
   * Find the project key for a given issue. The adapter doesn't know
   * which project an issue belongs to a priori — the orchestrator's
   * `Issue.projectKey` is the source of truth, but `AgentRunInput`
   * doesn't carry it (the runner interface predates Plan 09c).
   *
   * Pragmatic v1: assume single-project. The first key in
   * `projectDispatch` insertion order is used. Extracting the
   * authoritative key from the orchestrator's `running` entry is a
   * Plan 11 follow-up (ADR 0011's full orchestrator-uses-
   * ExecutionBackend rewrite); multi-project dispatch with the
   * adapter requires either threading `projectKey` through
   * `AgentRunInput` or wiring one adapter per project.
   */
  private findProjectKeyByIssue(_issueId: IssueId): Promise<ProjectKey | null> {
    const first = this.projectDispatch.keys().next();
    if (first.done === true) return Promise.resolve(null);
    return Promise.resolve(first.value);
  }

  private failed(reason: string): AgentEvent {
    return { kind: 'turn_failed', reason, at: this.now() };
  }
}
