// Public surface of the local-docker subpackage.
//
// `LocalDockerBackend` is the production v1 `ExecutionBackend` impl
// (Plan 10 / ADR 0011). The composition root constructs it when the
// deployment YAML's `execution.backend` is `local-docker`.
//
// Other implementations (`E2BBackend`, `EcsBackend`,
// `KubernetesJobBackend`) will live as siblings to this directory
// and implement the same `ExecutionBackend` interface.

export { LocalDockerBackend, buildDispatchEnvelope } from './backend.js';
export type { LocalDockerBackendArgs } from './backend.js';
export type { DockerResult, DockerRunner } from './docker-runner.js';
export { defaultDockerRunner } from './docker-runner.js';
export { resolveImage, perProjectTag } from './image-resolver.js';
export type { ResolveImageArgs } from './image-resolver.js';
export { bindEventSocket, EventSocketServer } from './socket-server.js';
export type { SocketServerArgs } from './socket-server.js';
