// Re-exports for the namespace ExecutionBackend (ADR 0012, Plan 14).

export { NamespaceBackend, type NamespaceBackendArgs } from './backend.js';
export {
  type InstanceRunner,
  type InstanceShape,
  type CreateInstanceArgs,
  type RunCommandArgs,
  type RunCommandChunk,
  type RunCommandSyncResult,
  type NamespaceRunnerOptions,
} from './instance-runner.js';
export { createNamespaceInstanceRunner } from './sdk-runner.js';
export { streamAgentEvents } from './event-stream.js';
