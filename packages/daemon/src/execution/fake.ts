// In-memory `ExecutionBackend` for tests.
//
// `FakeBackend` lets the orchestrator's tick loop run end-to-end
// without a docker daemon. Tests configure per-pod scenarios
// (events to yield, scripted failures) before kicking off
// orchestrator dispatch; the fake verifies the contract by
// satisfying it deterministically.
//
// Same role as `FakeTracker` (ADR 0007) — ships in production code
// because the orchestrator's composition root may pick it when the
// configured backend kind is `fake` (e.g. for a local dry-run that
// doesn't actually start containers).
//
// Idempotency contract (per ADR 0011): calling `start()` twice for
// the same `(projectKey, issueId)` returns the same handle with
// the same logical event stream. The fake honors this by keying
// handles on the pod name and reusing them.

import type { AgentEvent } from '../agent/runner.js';

import {
  podNameFor,
  type ExecutionBackend,
  type ImageRef,
  type ImageSpec,
  type PodHandle,
  type PodStartInput,
} from './backend.js';
import type { ExecutionError, ExecutionResult } from './errors.js';

/**
 * Per-pod scripted behavior. Tests set this via
 * `FakeBackend.setScenario(podName, scenario)` BEFORE the
 * orchestrator dispatches the corresponding issue.
 */
export interface PodScenario {
  /**
   * Events the pod will yield, in order. The fake terminates the
   * `events` iterable after the last item (callers do NOT need to
   * append a `turn_completed` synthetically — script it explicitly
   * if you want one).
   */
  readonly events?: readonly AgentEvent[];
  /**
   * If set, `start()` returns this error instead of a handle.
   * Useful for testing the orchestrator's "pod failed to start"
   * path.
   */
  readonly startError?: ExecutionError;
  /**
   * What `logsTail()` returns. Defaults to an empty string.
   */
  readonly logsTail?: string;
}

/**
 * Per-spec image resolution override. Tests call
 * `FakeBackend.setImageResult(projectKey, result)` to control
 * what `ensureImage` returns for a given project. Without an
 * override, `ensureImage` returns a synthesized success with
 * `tag: <projectKey>:fake` and `source: 'base'`.
 */
export type ImageOverride =
  | { readonly ok: true; readonly value: ImageRef }
  | { readonly ok: false; readonly error: ExecutionError };

/**
 * Trace of every call made to the backend, for test assertions.
 * Discriminated on `method` so tests can filter without unwrapping.
 */
export type BackendCall =
  | { readonly method: 'ensureImage'; readonly spec: ImageSpec }
  | { readonly method: 'start'; readonly input: PodStartInput }
  | { readonly method: 'stop'; readonly podId: string };

export class FakeBackend implements ExecutionBackend {
  private readonly imageOverrides = new Map<string, ImageOverride>();
  private readonly scenarios = new Map<string, PodScenario>();
  private readonly handles = new Map<string, PodHandle>();
  private readonly stoppedPodIds = new Set<string>();

  /** Public log of every call. Append-only. */
  readonly calls: BackendCall[] = [];

  // ---- Test programming surface --------------------------------------

  setImageResult(projectKey: string, override: ImageOverride): void {
    this.imageOverrides.set(projectKey, override);
  }

  setScenario(podName: string, scenario: PodScenario): void {
    this.scenarios.set(podName, scenario);
  }

  /** True if `stop()` was called for the given pod id. */
  wasStopped(podId: string): boolean {
    return this.stoppedPodIds.has(podId);
  }

  // ---- ExecutionBackend interface ------------------------------------

  ensureImage(spec: ImageSpec): Promise<ExecutionResult<ImageRef>> {
    this.calls.push({ method: 'ensureImage', spec });
    const override = this.imageOverrides.get(spec.projectKey);
    if (override !== undefined) {
      return Promise.resolve(override);
    }
    return Promise.resolve({
      ok: true,
      value: {
        tag: `${spec.projectKey}:fake`,
        source: 'base',
      },
    });
  }

  start(input: PodStartInput): Promise<ExecutionResult<PodHandle>> {
    this.calls.push({ method: 'start', input });
    const podName = podNameFor(input.projectKey, input.issueId);

    // Idempotency: if a handle exists for this pod name, reuse it.
    // This matches the production backends' contract — caller may
    // call `start()` after a daemon restart and reattach.
    const existing = this.handles.get(podName);
    if (existing !== undefined) {
      return Promise.resolve({ ok: true, value: existing });
    }

    const scenario = this.scenarios.get(podName) ?? {};
    if (scenario.startError !== undefined) {
      return Promise.resolve({ ok: false, error: scenario.startError });
    }

    const handle: PodHandle = {
      podId: podName,
      events: makeEventStream(scenario.events ?? [], input.signal),
      logsTail: () => Promise.resolve(scenario.logsTail ?? ''),
    };
    this.handles.set(podName, handle);
    return Promise.resolve({ ok: true, value: handle });
  }

  stop(handle: PodHandle): Promise<ExecutionResult<void>> {
    this.calls.push({ method: 'stop', podId: handle.podId });
    this.stoppedPodIds.add(handle.podId);
    this.handles.delete(handle.podId);
    return Promise.resolve({ ok: true, value: undefined });
  }
}

/**
 * Build a one-shot AsyncIterable from a fixed event list. Honors
 * the abort signal — when aborted mid-iteration, the next `for
 * await` step terminates cleanly without throwing (matching
 * production backends, which drop the stream on abort).
 *
 * The `await Promise.resolve()` between items is deliberate: it
 * yields back to the microtask queue between events, giving the
 * abort signal a real chance to fire mid-iteration and matching
 * the truly-async behavior production backends will exhibit
 * (each event awaits the next socket read). It also satisfies
 * `@typescript-eslint/require-await`, but that's the side effect
 * — the semantic point is the microtask boundary.
 */
function makeEventStream(
  events: readonly AgentEvent[],
  signal: AbortSignal | undefined,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        // Yield to the microtask queue so a pending `controller.abort()`
        // queued from the same tick can take effect before we emit the
        // next event. Truthy check (rather than `=== true`) sidesteps a
        // TypeScript narrowing quirk where the post-await re-check loses
        // the boolean type after the loop body runs once.
        await Promise.resolve();
        if (signal?.aborted) return;
        yield event;
      }
    },
  };
}
