// Barrel for the execution layer.
//
// Public surface for ADR 0011's `ExecutionBackend` abstraction:
// the orchestrator imports from here, not from individual files.

export {
  podNameFor,
  type DispatchEnvelope,
  type ExecutionBackend,
  type ImageRef,
  type ImageSource,
  type ImageSpec,
  type PodHandle,
  type PodStartInput,
} from './backend.js';

export {
  type EventStreamClosedError,
  type ExecutionError,
  type ExecutionResult,
  type ImageBuildFailedError,
  type ImageNotFoundError,
  type PodNotFoundError,
  type PodStartFailedError,
  type PodStopFailedError,
} from './errors.js';

export { FakeBackend, type BackendCall, type ImageOverride, type PodScenario } from './fake.js';
